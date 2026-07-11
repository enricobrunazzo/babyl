import type { WebSocket } from "ws";
import type {
  ChannelState,
  PeerInfo,
  RoomMode,
  ServerMessage,
  TranslationInfo,
  TranslationTiming,
} from "../../shared/protocol.ts";
import type {
  TranslationProvider,
  TranslationSession,
} from "./translation/provider.ts";

interface Peer {
  info: PeerInfo;
  socket: WebSocket;
  /**
   * Chiave di ripresa dichiarata dal client al join (segreta: mai broadcast).
   * Alla riconnessione un join con la stessa chiave riprende questo peer —
   * stessa identità nel roster, mano alzata e parola concessa conservate —
   * invece di crearne uno nuovo accanto allo zombie.
   */
  resumeKey?: string;
  /**
   * Modalità single-device: direzione di traduzione dell'enunciato corrente.
   * Se presente, l'audio del peer viene tradotto source→target e rimandato al
   * peer stesso invece che instradato agli altri ascoltatori della stanza.
   */
  solo?: { source: string; target: string };
}

/**
 * Arretrato massimo tollerato sul socket di un ascoltatore prima di scartare
 * i frame audio (~10 s di PCM16 24 kHz). L'audio è live: un client su rete
 * lenta deve perdere i frame in ritardo, non far crescere la memoria del
 * server all'infinito.
 */
const MAX_BUFFERED_BYTES = 512 * 1024;

/** Sessione di traduzione inutilizzata da così a lungo → chiusa (riaperta al
 *  prossimo PTT). Evita connessioni pendenti verso il motore nelle stanze
 *  lunghe con ore di silenzio, dove la sessione scadrebbe comunque lato OpenAI. */
const SESSION_IDLE_MS = 5 * 60_000;
const IDLE_SWEEP_MS = 60_000;

/** Millisecondi di audio PCM16 24 kHz rappresentati da `bytes` byte. */
function pcmDurationMs(bytes: number): number {
  // 24000 campioni/s · 2 byte = 48 byte/ms.
  return bytes / 48;
}

/** Statistiche per coppia di lingue: ms di audio in ingresso/uscita dal motore. */
export interface PairStats {
  inMs: number;
  outMs: number;
}

/** Fotografia dei consumi di una stanza (o aggregata). */
export interface RoomStats {
  peers: number;
  /** Byte audio ricevuti dai parlanti (payload base64 ≈ byte sul filo). */
  bytesIn: number;
  /** Byte audio inviati agli ascoltatori (originale + tradotto). */
  bytesOut: number;
  /** Millisecondi di canale occupato (PTT tenuto). */
  pttMs: number;
  /** Consumo del motore di traduzione per coppia di lingue. */
  pairs: Record<string, PairStats>;
}

/**
 * Una stanza di traduzione. Il server è l'unica autorità sullo stato del
 * canale Half-Duplex e l'unico snodo dell'audio: il flusso del parlante
 * arriva qui, va in voce originale agli ascoltatori della stessa lingua e
 * passa dal motore di traduzione per ciascuna altra lingua presente.
 * Senza provider (nessuna API key) tutti ricevono la voce originale.
 */
export class Room {
  readonly peers = new Map<string, Peer>();
  private speakerId: string | null = null;
  /**
   * Modalità della stanza. Parte "conversation" e diventa "event" (sticky) al
   * primo ingresso che la richiede: così anche se il pubblico entra prima del
   * relatore, la stanza è già una conferenza.
   */
  private mode: RoomMode = "conversation";
  /** Evento: pubblico con la mano alzata, in ordine di richiesta (Q&A). */
  private hands: string[] = [];
  /** Evento: partecipante del pubblico a cui è concessa la parola, o null. */
  private floor: string | null = null;
  /** Sessioni di traduzione attive, per coppia di lingue. */
  private sessions = new Map<string, Promise<TranslationSession>>();
  /** Ultimo uso di ciascuna sessione, per lo sweep di inattività. */
  private sessionLastUsed = new Map<string, number>();
  private idleSweep: ReturnType<typeof setInterval>;

  // Contatori diagnostici (esposti da GET /metrics).
  private mBytesIn = 0;
  private mBytesOut = 0;
  private mPttMs = 0;
  private lockStartedAt: number | null = null;
  private mPairs = new Map<string, PairStats>();

  constructor(
    readonly id: string,
    private provider: TranslationProvider | null,
    private timing: TranslationTiming = "streaming",
  ) {
    this.idleSweep = setInterval(() => this.closeIdleSessions(), IDLE_SWEEP_MS);
    // Non tenere vivo il processo per questo timer (test, shutdown).
    this.idleSweep.unref?.();
  }

  /**
   * Chiude le sessioni di traduzione inutilizzate da più di SESSION_IDLE_MS:
   * meno connessioni pendenti verso il motore e nessuna sorpresa da sessione
   * scaduta lato OpenAI. La prossima pressione PTT le ricrea.
   */
  closeIdleSessions(now = Date.now()): void {
    for (const [key, session] of this.sessions) {
      const lastUsed = this.sessionLastUsed.get(key) ?? now;
      if (now - lastUsed < SESSION_IDLE_MS) continue;
      void session.then((s) => s.close()).catch(() => {});
      this.sessions.delete(key);
      this.sessionLastUsed.delete(key);
    }
  }

  get translation(): TranslationInfo {
    return {
      enabled: this.provider !== null,
      provider: this.provider?.name ?? "off",
      timing: this.timing,
    };
  }

  /**
   * Cambia la tempistica per l'intera stanza. Le sessioni aperte usano ancora
   * la vecchia segmentazione: le chiudiamo, così la prossima pressione PTT le
   * ricrea col nuovo `turn_detection`.
   */
  setTiming(timing: TranslationTiming): void {
    if (timing === this.timing) return;
    this.timing = timing;
    for (const session of this.sessions.values()) {
      void session.then((s) => s.close()).catch(() => {});
    }
    this.sessions.clear();
    this.sessionLastUsed.clear();
    this.broadcast({ type: "timing", timing });
  }

  /** Fotografia dei consumi correnti, incluso il lock eventualmente in corso. */
  get stats(): RoomStats {
    const pairs: Record<string, PairStats> = {};
    for (const [key, value] of this.mPairs) pairs[key] = { ...value };
    const liveLock = this.lockStartedAt ? Date.now() - this.lockStartedAt : 0;
    return {
      peers: this.peers.size,
      bytesIn: this.mBytesIn,
      bytesOut: this.mBytesOut,
      pttMs: Math.round(this.mPttMs + liveLock),
      pairs,
    };
  }

  private pairStat(key: string): PairStats {
    let stat = this.mPairs.get(key);
    if (!stat) {
      stat = { inMs: 0, outMs: 0 };
      this.mPairs.set(key, stat);
    }
    return stat;
  }

  /** Chiude il cronometro del lock e accumula i ms nel totale PTT. */
  private endLock(): void {
    if (this.lockStartedAt === null) return;
    this.mPttMs += Date.now() - this.lockStartedAt;
    this.lockStartedAt = null;
  }

  get channel(): ChannelState {
    const speaker = this.speakerId ? this.peers.get(this.speakerId) : undefined;
    return {
      speakerId: speaker ? speaker.info.id : null,
      speakerName: speaker ? speaker.info.nickname : null,
    };
  }

  /**
   * Ingresso in stanza. Se `resumeKey` corrisponde a un peer già presente è
   * una riconnessione: il peer riprende la propria identità (stesso id nel
   * roster, mano alzata e parola concessa conservate) e il vecchio socket —
   * uno zombie che il heartbeat non ha ancora terminato — viene sostituito.
   * Ritorna l'id effettivo del peer (quello ripreso, se c'è stata ripresa).
   */
  join(
    info: PeerInfo,
    socket: WebSocket,
    mode: RoomMode = "conversation",
    resumeKey?: string,
  ): string {
    // La modalità evento è sticky: il primo ingresso che la chiede la fissa.
    if (mode === "event") this.mode = "event";

    const resumed = resumeKey
      ? [...this.peers.values()].find((p) => p.resumeKey === resumeKey)
      : undefined;
    if (resumed) {
      try {
        resumed.socket.terminate?.();
      } catch {
        // Zombie già chiuso.
      }
      // L'info esistente resta (nickname e lingua possono essere cambiati a
      // caldo in stanza: non vanno riportati ai valori dell'onboarding).
      resumed.socket = socket;
    } else {
      this.peers.set(info.id, { info, socket, resumeKey });
      this.broadcast({ type: "peer-joined", peer: info }, info.id);
    }

    const self = resumed?.info ?? info;
    this.send(self.id, {
      type: "welcome",
      self,
      peers: [...this.peers.values()]
        .filter((p) => p.info.id !== self.id)
        .map((p) => p.info),
      channel: this.channel,
      translation: this.translation,
      mode: this.mode,
      hands: [...this.hands],
      floor: this.floor,
    });
    return self.id;
  }

  /**
   * Uscita dalla stanza. `socket`, se fornito, fa da guardia: la chiusura di
   * un vecchio socket sostituito da una riconnessione (resumeKey) non deve
   * buttare fuori il peer che nel frattempo è rientrato.
   */
  leave(peerId: string, socket?: WebSocket): void {
    const peer = this.peers.get(peerId);
    if (!peer || (socket && peer.socket !== socket)) return;
    this.peers.delete(peerId);
    // Le sessioni single-device del peer non servono più a nessuno.
    const soloPrefix = `solo:${peerId}:`;
    for (const [key, session] of this.sessions) {
      if (!key.startsWith(soloPrefix)) continue;
      void session.then((s) => s.close()).catch(() => {});
      this.sessions.delete(key);
      this.sessionLastUsed.delete(key);
    }
    if (this.speakerId === peerId) {
      this.speakerId = null;
      this.endLock();
      this.commitUtterance();
      this.broadcast({ type: "channel", channel: this.channel });
    }
    // Evento: chi esce lascia la coda delle mani e, se aveva la parola, la libera.
    if (this.hands.includes(peerId)) {
      this.hands = this.hands.filter((id) => id !== peerId);
      this.broadcast({ type: "hands", hands: [...this.hands] });
    }
    if (this.floor === peerId) {
      this.floor = null;
      this.broadcast({ type: "floor", floor: null });
    }
    this.broadcast({ type: "peer-left", peerId });
  }

  /** Evento: il pubblico alza/abbassa la mano per chiedere la parola (Q&A). */
  raiseHand(peerId: string, raised: boolean): void {
    const peer = this.peers.get(peerId);
    if (!peer || peer.info.role !== "audience") return;
    const has = this.hands.includes(peerId);
    if (raised && !has) this.hands.push(peerId);
    else if (!raised && has) this.hands = this.hands.filter((id) => id !== peerId);
    else return;
    this.broadcast({ type: "hands", hands: [...this.hands] });
  }

  /**
   * Evento: un relatore concede la parola a un partecipante del pubblico.
   * Una sola parola concessa alla volta; il beneficiario esce dalla coda.
   */
  grantFloor(speakerId: string, targetId: string): void {
    const speaker = this.peers.get(speakerId);
    if (!speaker || speaker.info.role !== "speaker") return;
    const target = this.peers.get(targetId);
    if (!target || target.info.role !== "audience") return;
    this.floor = targetId;
    if (this.hands.includes(targetId)) {
      this.hands = this.hands.filter((id) => id !== targetId);
      this.broadcast({ type: "hands", hands: [...this.hands] });
    }
    this.broadcast({ type: "floor", floor: this.floor });
  }

  /** Evento: un relatore ritira la parola concessa (chiudendo il turno del Q&A). */
  revokeFloor(speakerId: string): void {
    const speaker = this.peers.get(speakerId);
    if (!speaker || speaker.info.role !== "speaker") return;
    if (this.floor === null) return;
    // Se il pubblico sta ancora parlando, chiudi anche il canale.
    if (this.speakerId === this.floor) this.releaseLock(this.floor);
    this.floor = null;
    this.broadcast({ type: "floor", floor: null });
  }

  updateLang(peerId: string, lang: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.info.lang = lang;
    this.broadcast({ type: "peer-updated", peer: peer.info });
  }

  /** Attiva/aggiorna la modalità single-device per il peer. */
  setSolo(peerId: string, source: string, target: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.solo = { source, target };
  }

  /** Concede il lock solo se il canale è libero (o già del richiedente). */
  requestLock(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    // Evento: il pubblico può trasmettere solo con la parola concessa.
    if (
      this.mode === "event" &&
      peer.info.role === "audience" &&
      this.floor !== peerId
    ) {
      this.send(peerId, { type: "ptt-denied", reason: "not-granted" });
      return;
    }
    if (this.speakerId !== null && this.speakerId !== peerId) {
      this.send(peerId, { type: "ptt-denied", reason: "busy" });
      return;
    }
    this.speakerId = peerId;
    if (this.lockStartedAt === null) this.lockStartedAt = Date.now();
    this.broadcast({ type: "channel", channel: this.channel });
  }

  releaseLock(peerId: string): void {
    if (this.speakerId !== peerId) return;
    this.speakerId = null;
    this.endLock();
    this.commitUtterance();
    this.broadcast({ type: "channel", channel: this.channel });
  }

  /**
   * Rilascia il canale scartando l'enunciato senza tradurlo (annullamento): il
   * buffer d'ingresso delle sessioni viene svuotato invece di essere committato.
   * In consecutiva (sempre in single-device) la traduzione non è ancora partita,
   * quindi non si spreca alcun token.
   */
  cancelLock(peerId: string): void {
    if (this.speakerId !== peerId) return;
    this.speakerId = null;
    this.endLock();
    this.discardUtterance();
    this.broadcast({ type: "channel", channel: this.channel });
  }

  /**
   * Interrompe la traduzione in corso di generazione per il richiedente. Agisce
   * solo sulle sue sessioni single-device (`solo:<peerId>:…`): lì il parlante è
   * anche l'ascoltatore, quindi fermare la generazione risparmia i suoi token
   * senza toccare le sessioni condivise di stanza, che servono altri ascoltatori.
   */
  stopTranslation(peerId: string): void {
    const prefix = `solo:${peerId}:`;
    for (const [key, session] of this.sessions) {
      if (!key.startsWith(prefix)) continue;
      void session.then((s) => s.cancelResponse()).catch(() => {});
    }
  }

  /** Chunk audio dal parlante come frame binario (PCM16 24 kHz). */
  handleAudio(peerId: string, data: Buffer): void {
    if (peerId !== this.speakerId) return; // solo chi detiene il lock
    const speaker = this.peers.get(peerId);
    if (!speaker) return;

    this.mBytesIn += data.length;
    // Il motore di traduzione parla base64: si converte solo al suo confine.
    const encoded = () => data.toString("base64");

    // Single-device: traduci source→target e rimanda l'audio al mittente,
    // senza toccare l'instradamento multi-peer della stanza.
    if (speaker.solo && this.provider) {
      const { source, target } = speaker.solo;
      this.pairStat(`${source}->${target}`).inMs += pcmDurationMs(data.length);
      this.sessionLastUsed.set(`solo:${peerId}:${source}->${target}`, Date.now());
      void this.soloSessionFor(peerId, source, target)
        .then((session) => session.appendAudio(encoded()))
        .catch(() => {});
      return;
    }

    for (const peer of this.peers.values()) {
      if (peer.info.id === peerId) continue;
      // Voce originale a chi parla la stessa lingua (o a tutti senza provider).
      if (!this.provider || peer.info.lang === speaker.info.lang) {
        this.sendBinary(peer.info.id, data);
      }
    }

    if (!this.provider) return;
    const durationMs = pcmDurationMs(data.length);
    for (const lang of this.listenerLangs(speaker.info.lang)) {
      const key = `${speaker.info.lang}->${lang}`;
      this.pairStat(key).inMs += durationMs;
      this.sessionLastUsed.set(key, Date.now());
      // Dichiara chi pronuncia l'audio che segue: il provider attribuisce i
      // segmenti per parlante (FIFO), così la coda tradotta resta instradata
      // e sottotitolata correttamente anche se il canale passa di mano.
      void this.sessionFor(speaker.info.lang, lang)
        .then((session) => {
          session.setSpeaker(peerId);
          session.appendAudio(encoded());
        })
        .catch(() => {});
    }
  }

  /** Avvisa gli ascoltatori di una lingua che la traduzione non è disponibile. */
  private notifyTranslationError(targetLang: string): void {
    for (const peer of this.peers.values()) {
      if (peer.info.lang === targetLang) {
        this.send(peer.info.id, { type: "translation-error" });
      }
    }
  }

  /** Lingue di destinazione: quelle degli ascoltatori diverse dal parlante. */
  private listenerLangs(speakerLang: string): Set<string> {
    const langs = new Set<string>();
    for (const peer of this.peers.values()) {
      if (peer.info.lang !== speakerLang) langs.add(peer.info.lang);
    }
    return langs;
  }

  private commitUtterance(): void {
    for (const session of this.sessions.values()) {
      void session.then((s) => s.commit()).catch(() => {});
    }
  }

  /** Scarta l'enunciato accumulato su tutte le sessioni (annullamento del PTT). */
  private discardUtterance(): void {
    for (const session of this.sessions.values()) {
      void session.then((s) => s.discard()).catch(() => {});
    }
  }

  /**
   * Sessione di traduzione per una coppia di lingue, creata pigramente e
   * riusata tra enunciati. La Promise entra subito nella mappa così i chunk
   * successivi si accodano in ordine anche mentre la connessione si apre.
   */
  private sessionFor(
    sourceLang: string,
    targetLang: string,
  ): Promise<TranslationSession> {
    const key = `${sourceLang}->${targetLang}`;
    let session = this.sessions.get(key);
    if (session) return session;

    session = this.provider!.createSession(sourceLang, targetLang, {
      onAudio: (chunk, speakerId) => {
        if (!speakerId) return;
        const audio = Buffer.from(chunk, "base64");
        this.pairStat(key).outMs += pcmDurationMs(audio.length);
        for (const peer of this.peers.values()) {
          if (peer.info.id !== speakerId && peer.info.lang === targetLang) {
            this.sendBinary(peer.info.id, audio);
          }
        }
      },
      onTranscript: (text, final, speakerId) => {
        if (!speakerId) return;
        for (const peer of this.peers.values()) {
          if (peer.info.id !== speakerId && peer.info.lang === targetLang) {
            this.send(peer.info.id, {
              type: "transcript",
              speakerId,
              text,
              final,
            });
          }
        }
      },
      onError: (error) => {
        console.error(
          `[babyl] traduzione ${key} in stanza "${this.id}":`,
          error.message,
        );
        // Sessione compromessa: la prossima pressione PTT ne creerà una nuova.
        this.sessions.get(key)?.then((s) => s.close()).catch(() => {});
        this.sessions.delete(key);
        this.sessionLastUsed.delete(key);
      },
    }, this.timing);
    this.sessions.set(key, session);
    session.catch((error: Error) => {
      console.error(`[babyl] apertura sessione ${key} fallita:`, error.message);
      this.sessions.delete(key);
      this.sessionLastUsed.delete(key);
      this.notifyTranslationError(targetLang);
    });
    return session;
  }

  /**
   * Sessione single-device: traduce source→target e rimanda l'audio (e i
   * sottotitoli) allo stesso peer. Timing sempre "consecutive": la voce
   * tradotta arriva al rilascio del PTT, quando il microfono è già chiuso —
   * così non si innesca il loop acustico mic↔altoparlante sullo stesso device.
   */
  private soloSessionFor(
    peerId: string,
    source: string,
    target: string,
  ): Promise<TranslationSession> {
    const key = `solo:${peerId}:${source}->${target}`;
    let session = this.sessions.get(key);
    if (session) return session;

    session = this.provider!.createSession(
      source,
      target,
      {
        onAudio: (chunk) => {
          const audio = Buffer.from(chunk, "base64");
          this.pairStat(`${source}->${target}`).outMs +=
            pcmDurationMs(audio.length);
          this.sendBinary(peerId, audio);
        },
        onTranscript: (text, final) => {
          this.send(peerId, { type: "transcript", speakerId: peerId, text, final });
        },
        onError: (error) => {
          console.error(
            `[babyl] traduzione ${key} in stanza "${this.id}":`,
            error.message,
          );
          this.sessions.get(key)?.then((s) => s.close()).catch(() => {});
          this.sessions.delete(key);
          this.sessionLastUsed.delete(key);
        },
      },
      "consecutive",
    );
    this.sessions.set(key, session);
    session.catch((error: Error) => {
      console.error(`[babyl] apertura sessione ${key} fallita:`, error.message);
      this.sessions.delete(key);
      this.sessionLastUsed.delete(key);
      this.send(peerId, { type: "translation-error" });
    });
    return session;
  }

  destroy(): void {
    clearInterval(this.idleSweep);
    for (const session of this.sessions.values()) {
      void session.then((s) => s.close()).catch(() => {});
    }
    this.sessions.clear();
    this.sessionLastUsed.clear();
  }

  send(peerId: string, message: ServerMessage): void {
    const peer = this.peers.get(peerId);
    if (peer && peer.socket.readyState === peer.socket.OPEN) {
      peer.socket.send(JSON.stringify(message));
    }
  }

  /**
   * Invia un frame audio binario (PCM16) a un peer. Se il socket ha troppo
   * arretrato (rete lenta), il frame viene scartato: l'audio è live e in
   * ritardo non servirebbe più, mentre accumularlo farebbe crescere la
   * memoria del server senza limite. Conta qui i byte davvero inviati.
   */
  sendBinary(peerId: string, data: Buffer): void {
    const peer = this.peers.get(peerId);
    if (!peer || peer.socket.readyState !== peer.socket.OPEN) return;
    if (peer.socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
    peer.socket.send(data);
    this.mBytesOut += data.length;
  }

  broadcast(message: ServerMessage, exceptId?: string): void {
    const payload = JSON.stringify(message);
    for (const peer of this.peers.values()) {
      if (peer.info.id === exceptId) continue;
      if (peer.socket.readyState === peer.socket.OPEN) {
        peer.socket.send(payload);
      }
    }
  }
}

/**
 * Consumi cumulati delle stanze già chiuse (il sistema è stateless: le stanze
 * vuote spariscono, ma i totali di consumo restano per la diagnostica).
 */
interface RetiredTotals {
  bytesIn: number;
  bytesOut: number;
  pttMs: number;
  inMs: number;
  outMs: number;
}

/** Fotografia esposta da GET /metrics. */
export interface MetricsSnapshot {
  uptimeSec: number;
  rooms: number;
  peers: number;
  totals: RetiredTotals;
  /** Stima di costo del motore (OpenAI Realtime): ~$0,06/min in, ~$0,24/min out. */
  estCostUsd: number;
  perRoom: Record<string, RoomStats>;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private startedAt = Date.now();
  private retired: RetiredTotals = {
    bytesIn: 0,
    bytesOut: 0,
    pttMs: 0,
    inMs: 0,
    outMs: 0,
  };

  constructor(
    private provider: TranslationProvider | null = null,
    private defaultTiming: TranslationTiming = "streaming",
  ) {}

  get(id: string): Room {
    let room = this.rooms.get(id);
    if (!room) {
      room = new Room(id, this.provider, this.defaultTiming);
      this.rooms.set(id, room);
    }
    return room;
  }

  /** Rimuove il peer e distrugge la stanza se vuota (sistema stateless). */
  leave(roomId: string, peerId: string, socket?: WebSocket): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.leave(peerId, socket);
    if (room.peers.size === 0) {
      this.fold(room.stats);
      room.destroy();
      this.rooms.delete(roomId);
    }
  }

  /** Ripiega i consumi di una stanza che sta per sparire nei totali cumulati. */
  private fold(stats: RoomStats): void {
    this.retired.bytesIn += stats.bytesIn;
    this.retired.bytesOut += stats.bytesOut;
    this.retired.pttMs += stats.pttMs;
    for (const pair of Object.values(stats.pairs)) {
      this.retired.inMs += pair.inMs;
      this.retired.outMs += pair.outMs;
    }
  }

  metricsSnapshot(): MetricsSnapshot {
    const totals: RetiredTotals = { ...this.retired };
    const perRoom: Record<string, RoomStats> = {};
    let peers = 0;
    for (const [id, room] of this.rooms) {
      const stats = room.stats;
      perRoom[id] = stats;
      peers += stats.peers;
      totals.bytesIn += stats.bytesIn;
      totals.bytesOut += stats.bytesOut;
      totals.pttMs += stats.pttMs;
      for (const pair of Object.values(stats.pairs)) {
        totals.inMs += pair.inMs;
        totals.outMs += pair.outMs;
      }
    }
    const estCostUsd =
      (totals.inMs / 60_000) * 0.06 + (totals.outMs / 60_000) * 0.24;
    return {
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      rooms: this.rooms.size,
      peers,
      totals,
      estCostUsd: Math.round(estCostUsd * 10_000) / 10_000,
      perRoom,
    };
  }
}
