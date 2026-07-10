import test from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import type {
  PeerInfo,
  ServerMessage,
  TranslationTiming,
} from "../../shared/protocol.ts";
import { Room, RoomManager } from "./rooms.ts";
import type {
  TranslationProvider,
  TranslationSession,
  UtteranceCallbacks,
} from "./translation/provider.ts";

interface FakeSocket {
  /** Messaggi di controllo JSON ricevuti. */
  sent: ServerMessage[];
  /** Frame audio binari ricevuti (PCM16). */
  binary: Buffer[];
  readyState: number;
  OPEN: number;
  send(payload: string | Buffer): void;
}

function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    sent: [],
    binary: [],
    readyState: 1,
    OPEN: 1,
    send(payload: string | Buffer) {
      if (typeof payload === "string") {
        socket.sent.push(JSON.parse(payload) as ServerMessage);
      } else {
        socket.binary.push(payload);
      }
    },
  };
  return socket;
}

function peer(id: string, lang = "it", nickname = id): PeerInfo {
  return { id, nickname, lang, joinedAt: Date.now() };
}

function ofType<T extends ServerMessage["type"]>(
  socket: FakeSocket,
  type: T,
): Extract<ServerMessage, { type: T }>[] {
  return socket.sent.filter(
    (m): m is Extract<ServerMessage, { type: T }> => m.type === type,
  );
}

function lastOfType<T extends ServerMessage["type"]>(
  socket: FakeSocket,
  type: T,
): Extract<ServerMessage, { type: T }> | undefined {
  return ofType(socket, type).at(-1);
}

/**
 * Provider finto: "traduce" trasformando l'audio in maiuscolo e registra
 * append/commit per verificare l'instradamento.
 */
class FakeProvider implements TranslationProvider {
  readonly name = "fake";
  readonly sessions: {
    key: string;
    timing: TranslationTiming;
    appended: string[];
    commits: number;
    closed: boolean;
    callbacks: UtteranceCallbacks;
  }[] = [];

  async createSession(
    sourceLang: string,
    targetLang: string,
    callbacks: UtteranceCallbacks,
    timing: TranslationTiming,
  ): Promise<TranslationSession> {
    const record = {
      key: `${sourceLang}->${targetLang}`,
      timing,
      appended: [] as string[],
      commits: 0,
      closed: false,
      callbacks,
    };
    this.sessions.push(record);
    return {
      sourceLang,
      targetLang,
      appendAudio(data) {
        record.appended.push(data);
        callbacks.onAudio(data.toUpperCase());
      },
      commit() {
        record.commits += 1;
      },
      close() {
        record.closed = true;
      },
    };
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("join: welcome con stato traduzione, peer-joined agli altri", () => {
  const room = new Room("demo", null);
  const a = fakeSocket();
  const b = fakeSocket();

  room.join(peer("a", "it", "Marco"), a as unknown as WebSocket);
  room.join(peer("b", "de", "Anna"), b as unknown as WebSocket);

  const welcome = lastOfType(b, "welcome");
  assert.equal(welcome?.self.nickname, "Anna");
  assert.deepEqual(welcome?.peers.map((p) => p.id), ["a"]);
  assert.equal(welcome?.channel.speakerId, null);
  assert.deepEqual(welcome?.translation, {
    enabled: false,
    provider: "off",
    timing: "streaming",
  });

  assert.equal(lastOfType(a, "peer-joined")?.peer.nickname, "Anna");
});

test("lock PTT: esclusivo, negato se occupato, rilasciato correttamente", () => {
  const room = new Room("demo", null);
  const a = fakeSocket();
  const b = fakeSocket();
  room.join(peer("a", "it", "Marco"), a as unknown as WebSocket);
  room.join(peer("b", "de", "Anna"), b as unknown as WebSocket);

  room.requestLock("a");
  assert.equal(room.channel.speakerId, "a");
  assert.equal(lastOfType(b, "channel")?.channel.speakerName, "Marco");

  room.requestLock("b");
  assert.equal(room.channel.speakerId, "a");
  assert.equal(lastOfType(b, "ptt-denied")?.reason, "busy");

  room.releaseLock("b");
  assert.equal(room.channel.speakerId, "a");

  room.releaseLock("a");
  assert.equal(room.channel.speakerId, null);

  room.requestLock("b");
  assert.equal(room.channel.speakerId, "b");
});

test("audio senza provider: voce originale a tutti gli ascoltatori", () => {
  const room = new Room("demo", null);
  const a = fakeSocket();
  const b = fakeSocket();
  const c = fakeSocket();
  room.join(peer("a", "it"), a as unknown as WebSocket);
  room.join(peer("b", "de"), b as unknown as WebSocket);
  room.join(peer("c", "it"), c as unknown as WebSocket);

  // Senza lock l'audio viene ignorato
  room.handleAudio("a", Buffer.from("chunk0"));
  assert.equal(b.binary.length, 0);

  room.requestLock("a");
  const chunk = Buffer.from("chunk1");
  room.handleAudio("a", chunk);

  assert.deepEqual(b.binary, [chunk]);
  assert.deepEqual(c.binary, [chunk]);
  assert.equal(a.binary.length, 0); // mai a chi parla
});

test("audio con provider: originale alla stessa lingua, tradotto alle altre", async () => {
  const provider = new FakeProvider();
  const room = new Room("demo", provider);
  const a = fakeSocket();
  const b = fakeSocket();
  const c = fakeSocket();
  room.join(peer("a", "it"), a as unknown as WebSocket);
  room.join(peer("b", "de"), b as unknown as WebSocket);
  room.join(peer("c", "it"), c as unknown as WebSocket);

  room.requestLock("a");
  const chunk = Buffer.from("ciao");
  room.handleAudio("a", chunk);
  await tick();

  // c (stessa lingua): voce originale, frame binario identico
  assert.deepEqual(c.binary, [chunk]);
  // b (tedesco): un frame tradotto, arrivato dalla sessione it->de
  assert.equal(b.binary.length, 1);
  assert.equal(provider.sessions.length, 1);
  assert.equal(provider.sessions[0].key, "it->de");
  assert.deepEqual(provider.sessions[0].appended, [chunk.toString("base64")]);

  // Il rilascio del PTT esegue il commit dell'enunciato
  room.releaseLock("a");
  await tick();
  assert.equal(provider.sessions[0].commits, 1);
});

test("sottotitoli: la trascrizione arriva solo agli ascoltatori della lingua", async () => {
  const provider = new FakeProvider();
  const room = new Room("demo", provider);
  const a = fakeSocket();
  const b = fakeSocket();
  const c = fakeSocket();
  room.join(peer("a", "it"), a as unknown as WebSocket);
  room.join(peer("b", "de"), b as unknown as WebSocket);
  room.join(peer("c", "it"), c as unknown as WebSocket);

  room.requestLock("a");
  room.handleAudio("a", Buffer.from("ciao"));
  await tick();

  provider.sessions[0].callbacks.onTranscript("Hallo", true);
  const transcript = lastOfType(b, "transcript");
  assert.equal(transcript?.text, "Hallo");
  assert.equal(transcript?.final, true);
  assert.equal(transcript?.speakerId, "a");
  assert.equal(ofType(c, "transcript").length, 0);
  assert.equal(ofType(a, "transcript").length, 0);
});

test("leave dello speaker: canale libero e commit dell'enunciato", async () => {
  const provider = new FakeProvider();
  const room = new Room("demo", provider);
  const a = fakeSocket();
  const b = fakeSocket();
  room.join(peer("a", "it"), a as unknown as WebSocket);
  room.join(peer("b", "de"), b as unknown as WebSocket);

  room.requestLock("a");
  room.handleAudio("a", Buffer.from("ciao"));
  await tick();
  room.leave("a");
  await tick();

  assert.equal(room.channel.speakerId, null);
  assert.equal(lastOfType(b, "channel")?.channel.speakerId, null);
  assert.equal(lastOfType(b, "peer-left")?.peerId, "a");
  assert.equal(provider.sessions[0].commits, 1);
});

test("RoomManager: distrugge le stanze vuote e chiude le sessioni", async () => {
  const provider = new FakeProvider();
  const manager = new RoomManager(provider);
  const room = manager.get("effimera");
  const a = fakeSocket();
  const b = fakeSocket();
  room.join(peer("a", "it"), a as unknown as WebSocket);
  room.join(peer("b", "de"), b as unknown as WebSocket);
  room.requestLock("a");
  room.handleAudio("a", Buffer.from("ciao"));
  await tick();

  manager.leave("effimera", "a");
  manager.leave("effimera", "b");
  await tick();

  assert.notEqual(manager.get("effimera"), room);
  assert.equal(provider.sessions[0].closed, true);
});

test("setTiming: sessioni create con la tempistica corrente, cambio la propaga", async () => {
  const provider = new FakeProvider();
  const room = new Room("demo", provider, "streaming");
  const a = fakeSocket();
  const b = fakeSocket();
  room.join(peer("a", "it"), a as unknown as WebSocket);
  room.join(peer("b", "de"), b as unknown as WebSocket);

  assert.equal(lastOfType(b, "welcome")?.translation.timing, "streaming");

  room.requestLock("a");
  room.handleAudio("a", Buffer.from("ciao"));
  await tick();
  assert.equal(provider.sessions[0].timing, "streaming");

  // Cambio tempistica: la sessione aperta viene chiusa e il cambio propagato.
  room.setTiming("interview");
  await tick();
  assert.equal(provider.sessions[0].closed, true);
  assert.equal(lastOfType(a, "timing")?.timing, "interview");
  assert.equal(lastOfType(b, "timing")?.timing, "interview");

  // La pressione successiva ricrea la sessione con la nuova tempistica.
  room.handleAudio("a", Buffer.from("ancora"));
  await tick();
  assert.equal(provider.sessions.length, 2);
  assert.equal(provider.sessions[1].timing, "interview");

  // Reimpostare lo stesso valore non produce broadcast aggiuntivi.
  const before = ofType(a, "timing").length;
  room.setTiming("interview");
  assert.equal(ofType(a, "timing").length, before);
});

test("single-device: traduce source→target e rimanda l'audio al mittente", async () => {
  const provider = new FakeProvider();
  const room = new Room("solo", provider);
  const a = fakeSocket();
  const b = fakeSocket();
  room.join(peer("a", "it"), a as unknown as WebSocket);
  room.join(peer("b", "de"), b as unknown as WebSocket);
  room.setSolo("a", "it", "en");

  room.requestLock("a");
  const chunk = Buffer.from("ciao");
  room.handleAudio("a", chunk);
  await tick();

  // Il tradotto (frame binario) torna al mittente stesso, in consecutiva.
  assert.equal(a.binary.length, 1);
  assert.equal(provider.sessions.length, 1);
  assert.equal(provider.sessions[0].key, "it->en");
  assert.equal(provider.sessions[0].timing, "consecutive");
  assert.deepEqual(provider.sessions[0].appended, [chunk.toString("base64")]);
  // Il ramo solo è isolato: gli altri peer non ricevono nulla.
  assert.equal(b.binary.length, 0);

  room.releaseLock("a");
  await tick();
  assert.equal(provider.sessions[0].commits, 1);

  const pair = room.stats.pairs["it->en"];
  assert.ok(pair && pair.inMs > 0 && pair.outMs > 0);
});

const failingProvider = (): TranslationProvider => ({
  name: "boom",
  createSession: () =>
    Promise.reject(new Error("Unexpected server response: 503")),
});

test("traduzione ko: avvisa gli ascoltatori con translation-error", async () => {
  const room = new Room("ko", failingProvider());
  const a = fakeSocket();
  const b = fakeSocket();
  room.join(peer("a", "it"), a as unknown as WebSocket);
  room.join(peer("b", "de"), b as unknown as WebSocket);

  room.requestLock("a");
  room.handleAudio("a", Buffer.from("ciao"));
  await tick();

  // b (de) attende la traduzione: viene avvisato che non è disponibile.
  assert.equal(ofType(b, "translation-error").length, 1);
  // a (parlante, stessa lingua): nessun avviso.
  assert.equal(ofType(a, "translation-error").length, 0);
});

test("single-device: traduzione ko avvisa il dispositivo stesso", async () => {
  const room = new Room("solo-ko", failingProvider());
  const a = fakeSocket();
  room.join(peer("a", "it"), a as unknown as WebSocket);
  room.setSolo("a", "it", "en");

  room.requestLock("a");
  room.handleAudio("a", Buffer.from("ciao"));
  await tick();

  assert.equal(ofType(a, "translation-error").length, 1);
});

test("metrics: conta byte e ms d'inferenza, i totali sopravvivono alla stanza", async () => {
  const provider = new FakeProvider();
  const manager = new RoomManager(provider);
  const room = manager.get("misura");
  const a = fakeSocket();
  const b = fakeSocket();
  room.join(peer("a", "it"), a as unknown as WebSocket);
  room.join(peer("b", "de"), b as unknown as WebSocket);

  const data = Buffer.alloc(48); // 48 byte PCM16 → 1 ms di audio a 24 kHz
  room.requestLock("a");
  room.handleAudio("a", data);
  await tick();
  room.releaseLock("a");

  const snap = manager.metricsSnapshot();
  assert.equal(snap.rooms, 1);
  assert.equal(snap.peers, 2);
  // b è di lingua diversa: riceve solo il tradotto (stessa lunghezza).
  assert.equal(snap.totals.bytesIn, data.length);
  assert.equal(snap.totals.bytesOut, data.length);
  const pair = snap.perRoom["misura"].pairs["it->de"];
  assert.equal(pair.inMs, data.length / 48);
  assert.equal(pair.outMs, data.length / 48);

  // Chiusa la stanza, i consumi restano nei totali cumulati.
  manager.leave("misura", "a");
  manager.leave("misura", "b");
  const after = manager.metricsSnapshot();
  assert.equal(after.rooms, 0);
  assert.equal(after.totals.bytesIn, data.length);
  assert.equal(after.totals.outMs, data.length / 48);
  assert.ok(after.estCostUsd >= 0);
});
