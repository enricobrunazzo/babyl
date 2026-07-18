import test from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import type {
  PeerInfo,
  PeerRole,
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
  /** Arretrato simulato sul socket (backpressure). */
  bufferedAmount: number;
  send(payload: string | Buffer): void;
}

function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    sent: [],
    binary: [],
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
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

function peer(
  id: string,
  lang = "it",
  nickname = id,
  role: PeerRole = "speaker",
): PeerInfo {
  return { id, nickname, lang, role, joinedAt: Date.now() };
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
 * append/commit per verificare l'instradamento. Come quello vero, attribuisce
 * l'audio tradotto al parlante dichiarato via setSpeaker.
 */
class FakeProvider implements TranslationProvider {
  readonly name = "fake";
  readonly sessions: {
    key: string;
    timing: TranslationTiming;
    appended: string[];
    speaker: string;
    commits: number;
    discards: number;
    cancels: number;
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
      speaker: "",
      commits: 0,
      discards: 0,
      cancels: 0,
      closed: false,
      callbacks,
    };
    this.sessions.push(record);
    return {
      sourceLang,
      targetLang,
      setSpeaker(speakerId) {
        record.speaker = speakerId;
      },
      appendAudio(data) {
        record.appended.push(data);
        callbacks.onAudio(data.toUpperCase(), record.speaker);
      },
      commit() {
        record.commits += 1;
      },
      discard() {
        record.discards += 1;
      },
      cancelResponse() {
        record.cancels += 1;
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

  provider.sessions[0].callbacks.onTranscript("Hallo", true, "a");
  const transcript = lastOfType(b, "transcript");
  assert.equal(transcript?.text, "Hallo");
  assert.equal(transcript?.final, true);
  assert.equal(transcript?.speakerId, "a");
  assert.equal(ofType(c, "transcript").length, 0);
  assert.equal(ofType(a, "transcript").length, 0);
});

test("conversazione a 3: la coda tradotta di un enunciato va ai suoi ascoltatori anche se un altro peer ha già preso il PTT", async () => {
  const provider = new FakeProvider();
  const room = new Room("tre", provider);
  const a = fakeSocket();
  const b = fakeSocket();
  const c = fakeSocket();
  room.join(peer("a", "it"), a as unknown as WebSocket);
  room.join(peer("b", "de"), b as unknown as WebSocket);
  room.join(peer("c", "de"), c as unknown as WebSocket);

  // a (it) parla: si apre la sessione it->de per gli ascoltatori tedeschi.
  room.requestLock("a");
  room.handleAudio("a", Buffer.from("ciao"));
  await tick();
  room.releaseLock("a");
  const bBefore = b.binary.length;
  const cBefore = c.binary.length;

  // b prende il canale prima che la coda di traduzione di a rientri dal motore.
  room.requestLock("b");

  // Ora arriva la coda tradotta dell'enunciato di a: il provider la
  // attribuisce ad a (FIFO dei segmenti), non a chi tiene il canale.
  provider.sessions[0].callbacks.onAudio("coda", "a");

  // Entrambi gli ascoltatori tedeschi la ricevono: b non deve essere escluso
  // solo perché nel frattempo tiene il PTT.
  assert.equal(b.binary.length, bBefore + 1);
  assert.equal(c.binary.length, cBefore + 1);

  // Il sottotitolo resta attribuito ad a (chi ha pronunciato l'enunciato).
  provider.sessions[0].callbacks.onTranscript("Hallo", true, "a");
  assert.equal(lastOfType(b, "transcript")?.speakerId, "a");
  assert.equal(lastOfType(c, "transcript")?.speakerId, "a");
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

test("cancelLock: scarta l'enunciato senza tradurlo (nessun commit)", async () => {
  const provider = new FakeProvider();
  const room = new Room("annulla", provider);
  const a = fakeSocket();
  const b = fakeSocket();
  room.join(peer("a", "it"), a as unknown as WebSocket);
  room.join(peer("b", "de"), b as unknown as WebSocket);

  room.requestLock("a");
  room.handleAudio("a", Buffer.from("ciao"));
  await tick();

  // Annulla invece di rilasciare: l'audio accumulato viene scartato, non tradotto.
  room.cancelLock("a");
  await tick();

  assert.equal(room.channel.speakerId, null);
  assert.equal(lastOfType(b, "channel")?.channel.speakerId, null);
  assert.equal(provider.sessions[0].discards, 1);
  assert.equal(provider.sessions[0].commits, 0);
});

test("cancelLock: agisce solo se il richiedente detiene il canale", async () => {
  const provider = new FakeProvider();
  const room = new Room("annulla2", provider);
  const a = fakeSocket();
  const b = fakeSocket();
  room.join(peer("a", "it"), a as unknown as WebSocket);
  room.join(peer("b", "de"), b as unknown as WebSocket);

  room.requestLock("a");
  room.handleAudio("a", Buffer.from("ciao"));
  await tick();

  // b non tiene il canale: il suo annullamento è ignorato.
  room.cancelLock("b");
  await tick();
  assert.equal(room.channel.speakerId, "a");
  assert.equal(provider.sessions[0].discards, 0);
});

test("stopTranslation: annulla la generazione solo delle sessioni single-device del richiedente", async () => {
  const provider = new FakeProvider();
  const room = new Room("stop", provider);
  const a = fakeSocket();
  const b = fakeSocket();
  const c = fakeSocket();
  room.join(peer("a", "it"), a as unknown as WebSocket);
  room.join(peer("b", "de"), b as unknown as WebSocket);
  room.join(peer("c", "fr"), c as unknown as WebSocket);
  room.setSolo("a", "it", "en");

  // a (single-device) apre la sua sessione solo:a:it->en.
  room.requestLock("a");
  room.handleAudio("a", Buffer.from("ciao"));
  await tick();
  room.releaseLock("a");
  await tick();

  // b è un peer di stanza normale: parlando apre sessioni condivise (de->fr).
  room.requestLock("b");
  room.handleAudio("b", Buffer.from("hallo"));
  await tick();

  const soloSession = provider.sessions.find((s) => s.key === "it->en");
  const sharedSession = provider.sessions.find((s) => s.key === "de->fr");
  assert.ok(soloSession && sharedSession);

  // a interrompe: solo la sua sessione single-device viene annullata.
  room.stopTranslation("a");
  await tick();
  assert.equal(soloSession!.cancels, 1);
  assert.equal(sharedSession!.cancels, 0);
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

test("evento: il pubblico non può prendere il canale senza la parola concessa", () => {
  const room = new Room("evento", null);
  const relatore = fakeSocket();
  const spettatore = fakeSocket();
  room.join(peer("r", "it", "Relatore", "speaker"), relatore as unknown as WebSocket, "event");
  room.join(peer("s", "de", "Spettatore", "audience"), spettatore as unknown as WebSocket, "event");

  // welcome del pubblico riporta la modalità evento.
  assert.equal(lastOfType(spettatore, "welcome")?.mode, "event");

  // Il pubblico chiede il canale: negato con reason "not-granted".
  room.requestLock("s");
  assert.equal(room.channel.speakerId, null);
  assert.equal(lastOfType(spettatore, "ptt-denied")?.reason, "not-granted");

  // Il relatore invece parla liberamente.
  room.requestLock("r");
  assert.equal(room.channel.speakerId, "r");
});

test("evento: alzata di mano, concessione e ritiro della parola (Q&A)", () => {
  const room = new Room("qa", null);
  const relatore = fakeSocket();
  const spettatore = fakeSocket();
  room.join(peer("r", "it", "Relatore", "speaker"), relatore as unknown as WebSocket, "event");
  room.join(peer("s", "de", "Spettatore", "audience"), spettatore as unknown as WebSocket, "event");

  // Il pubblico alza la mano: la coda si propaga a tutti.
  room.raiseHand("s", true);
  assert.deepEqual(lastOfType(relatore, "hands")?.hands, ["s"]);

  // Un relatore concede la parola: il beneficiario esce dalla coda.
  room.grantFloor("r", "s");
  assert.equal(lastOfType(spettatore, "floor")?.floor, "s");
  assert.deepEqual(lastOfType(relatore, "hands")?.hands, []);

  // Ora il pubblico può trasmettere.
  room.requestLock("s");
  assert.equal(room.channel.speakerId, "s");

  // Il relatore ritira la parola mentre il pubblico parla: canale e parola liberi.
  room.revokeFloor("r");
  assert.equal(room.channel.speakerId, null);
  assert.equal(lastOfType(spettatore, "floor")?.floor, null);

  // Senza parola, il pubblico non trasmette più.
  room.requestLock("s");
  assert.equal(room.channel.speakerId, null);
});

test("evento: solo un relatore può concedere la parola", () => {
  const room = new Room("perm", null);
  const relatore = fakeSocket();
  const a = fakeSocket();
  const b = fakeSocket();
  room.join(peer("r", "it", "Relatore", "speaker"), relatore as unknown as WebSocket, "event");
  room.join(peer("a", "de", "A", "audience"), a as unknown as WebSocket, "event");
  room.join(peer("b", "fr", "B", "audience"), b as unknown as WebSocket, "event");

  // Un membro del pubblico non può concedere la parola a un altro.
  room.grantFloor("a", "b");
  assert.equal(room.channel.speakerId, null);
  assert.equal(lastOfType(b, "floor"), undefined);

  // Uscendo, chi ha la parola la libera per tutti.
  room.grantFloor("r", "a");
  assert.equal(lastOfType(a, "floor")?.floor, "a");
  room.leave("a");
  assert.equal(lastOfType(b, "floor")?.floor, null);
});

test("riconnessione: un join con lo stesso resumeKey riprende identità e parola", () => {
  const room = new Room("resume", null);
  const relatore = fakeSocket();
  const vecchio = fakeSocket();
  room.join(peer("r", "it", "Relatore", "speaker"), relatore as unknown as WebSocket, "event");
  room.join(
    peer("s", "de", "Spettatore", "audience"),
    vecchio as unknown as WebSocket,
    "event",
    "chiave-segreta",
  );
  room.raiseHand("s", true);
  room.grantFloor("r", "s");

  // Il socket muore in background (zombie, nessun close): il client rientra
  // con un nuovo socket, un nuovo id provvisorio e la stessa chiave.
  const nuovo = fakeSocket();
  const id = room.join(
    peer("id-provvisorio", "de", "Spettatore", "audience"),
    nuovo as unknown as WebSocket,
    "event",
    "chiave-segreta",
  );

  // Stessa identità di prima: id ripreso, parola concessa conservata.
  assert.equal(id, "s");
  const welcome = lastOfType(nuovo, "welcome");
  assert.equal(welcome?.self.id, "s");
  assert.equal(welcome?.floor, "s");
  // Gli altri non vedono un doppione entrare.
  assert.equal(ofType(relatore, "peer-joined").length, 1);
  assert.equal(room.peers.size, 2);

  // La chiusura tardiva del vecchio socket non butta fuori il peer rientrato.
  room.leave("s", vecchio as unknown as WebSocket);
  assert.equal(room.peers.size, 2);

  // La parola conservata permette subito di trasmettere.
  room.requestLock("s");
  assert.equal(room.channel.speakerId, "s");
});

test("leave: chiude le sessioni single-device del peer, non quelle condivise", async () => {
  const provider = new FakeProvider();
  const room = new Room("orfane", provider);
  const a = fakeSocket();
  const b = fakeSocket();
  room.join(peer("a", "it"), a as unknown as WebSocket);
  room.join(peer("b", "de"), b as unknown as WebSocket);
  room.setSolo("a", "it", "en");

  // a apre la sua sessione single-device...
  room.requestLock("a");
  room.handleAudio("a", Buffer.from("ciao"));
  await tick();
  room.releaseLock("a");

  // ...e b una sessione condivisa di stanza.
  room.requestLock("b");
  room.handleAudio("b", Buffer.from("hallo"));
  await tick();

  const solo = provider.sessions.find((s) => s.key === "it->en");
  const condivisa = provider.sessions.find((s) => s.key === "de->it");
  assert.ok(solo && condivisa);

  room.leave("a");
  await tick();
  assert.equal(solo!.closed, true);
  assert.equal(condivisa!.closed, false);
});

test("backpressure: frame scartati verso i socket con troppo arretrato", () => {
  const room = new Room("lenta", null);
  const a = fakeSocket();
  const b = fakeSocket();
  const c = fakeSocket();
  room.join(peer("a", "it"), a as unknown as WebSocket);
  room.join(peer("b", "it"), b as unknown as WebSocket);
  room.join(peer("c", "it"), c as unknown as WebSocket);

  // b è su una rete lenta: il suo socket ha accumulato troppo arretrato.
  b.bufferedAmount = 600 * 1024;

  room.requestLock("a");
  const chunk = Buffer.from("chunk");
  room.handleAudio("a", chunk);

  // Il frame per b viene scartato (audio live, in ritardo non serve più);
  // c lo riceve normalmente e i byte contati sono solo quelli inviati.
  assert.equal(b.binary.length, 0);
  assert.deepEqual(c.binary, [chunk]);
  assert.equal(room.stats.bytesOut, chunk.length);
});

test("sessioni inattive: chiuse dallo sweep, ricreate alla pressione successiva", async () => {
  const provider = new FakeProvider();
  const room = new Room("pigra", provider);
  const a = fakeSocket();
  const b = fakeSocket();
  room.join(peer("a", "it"), a as unknown as WebSocket);
  room.join(peer("b", "de"), b as unknown as WebSocket);

  room.requestLock("a");
  room.handleAudio("a", Buffer.from("ciao"));
  await tick();
  room.releaseLock("a");
  assert.equal(provider.sessions.length, 1);

  // Sotto la soglia di inattività la sessione resta aperta...
  room.closeIdleSessions(Date.now() + 60_000);
  await tick();
  assert.equal(provider.sessions[0].closed, false);

  // ...oltre la soglia viene chiusa (niente connessioni pendenti al motore).
  room.closeIdleSessions(Date.now() + 6 * 60_000);
  await tick();
  assert.equal(provider.sessions[0].closed, true);

  // La pressione PTT successiva la ricrea in modo trasparente.
  room.requestLock("a");
  room.handleAudio("a", Buffer.from("ancora"));
  await tick();
  assert.equal(provider.sessions.length, 2);
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

test("idratazione da evento: la stanza adotta tempistica e modalità salvate", () => {
  const mgr = new RoomManager(null, "streaming", (slug) =>
    slug === "piazza" ? { timing: "consecutive", mode: "event" } : null,
  );
  const s = fakeSocket();
  mgr.get("piazza").join(peer("a", "it"), s as unknown as WebSocket);
  const welcome = lastOfType(s, "welcome");
  assert.equal(welcome?.translation.timing, "consecutive");
  assert.equal(welcome?.mode, "event");

  // Slug senza evento corrispondente: default del server invariati.
  const s2 = fakeSocket();
  mgr.get("altra").join(peer("b", "it"), s2 as unknown as WebSocket);
  const w2 = lastOfType(s2, "welcome");
  assert.equal(w2?.translation.timing, "streaming");
  assert.equal(w2?.mode, "conversation");
});
