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
  sent: ServerMessage[];
  readyState: number;
  OPEN: number;
  send(payload: string): void;
}

function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    sent: [],
    readyState: 1,
    OPEN: 1,
    send(payload: string) {
      socket.sent.push(JSON.parse(payload) as ServerMessage);
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
  room.handleAudio("a", "chunk0");
  assert.equal(ofType(b, "audio").length, 0);

  room.requestLock("a");
  room.handleAudio("a", "chunk1");

  assert.deepEqual(
    ofType(b, "audio").map((m) => m.data),
    ["chunk1"],
  );
  assert.deepEqual(
    ofType(c, "audio").map((m) => m.data),
    ["chunk1"],
  );
  assert.equal(ofType(a, "audio").length, 0); // mai a chi parla
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
  room.handleAudio("a", "ciao");
  await tick();

  // c (stessa lingua): voce originale
  assert.deepEqual(
    ofType(c, "audio").map((m) => m.data),
    ["ciao"],
  );
  // b (tedesco): audio "tradotto" dal provider finto
  assert.deepEqual(
    ofType(b, "audio").map((m) => m.data),
    ["CIAO"],
  );
  // una sola sessione it->de
  assert.equal(provider.sessions.length, 1);
  assert.equal(provider.sessions[0].key, "it->de");

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
  room.handleAudio("a", "ciao");
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
  room.handleAudio("a", "ciao");
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
  room.handleAudio("a", "ciao");
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
  room.handleAudio("a", "ciao");
  await tick();
  assert.equal(provider.sessions[0].timing, "streaming");

  // Cambio tempistica: la sessione aperta viene chiusa e il cambio propagato.
  room.setTiming("interview");
  await tick();
  assert.equal(provider.sessions[0].closed, true);
  assert.equal(lastOfType(a, "timing")?.timing, "interview");
  assert.equal(lastOfType(b, "timing")?.timing, "interview");

  // La pressione successiva ricrea la sessione con la nuova tempistica.
  room.handleAudio("a", "ancora");
  await tick();
  assert.equal(provider.sessions.length, 2);
  assert.equal(provider.sessions[1].timing, "interview");

  // Reimpostare lo stesso valore non produce broadcast aggiuntivi.
  const before = ofType(a, "timing").length;
  room.setTiming("interview");
  assert.equal(ofType(a, "timing").length, before);
});
