import type { WebSocket } from "ws";
import type {
  ChannelState,
  PeerInfo,
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
   * Modalità single-device: direzione di traduzione dell'enunciato corrente.
   * Se presente, l'audio del peer viene tradotto source→target e rimandato al
   * peer stesso invece che instradato agli altri ascoltatori della stanza.
   */
  solo?: { source: string; target: string };
}

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
  /** Ultimo parlante: l'audio tradotto arriva dopo il rilascio del lock. */
  private lastSpeakerId: string | null = null;
  /** Sessioni di traduzione attive, per lingua di destinazione. */
  private sessions = new Map<string, Promise<TranslationSession>>();

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
  ) {}

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

  join(info: PeerInfo, socket: WebSocket): void {
    this.peers.set(info.id, { info, socket });
    this.broadcast({ type: "peer-joined", peer: info }, info.id);
    this.send(info.id, {
      type: "welcome",
      self: info,
      peers: [...this.peers.values()]
        .filter((p) => p.info.id !== info.id)
        .map((p) => p.info),
      channel: this.channel,
      translation: this.translation,
    });
  }

  leave(peerId: string): void {
    if (!this.peers.delete(peerId)) return;
    if (this.speakerId === peerId) {
      this.speakerId = null;
      this.endLock();
      this.commitUtterance();
      this.broadcast({ type: "channel", channel: this.channel });
    }
    this.broadcast({ type: "peer-left", peerId });
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
    if (this.speakerId !== null && this.speakerId !== peerId) {
      this.send(peerId, { type: "ptt-denied", reason: "busy" });
      return;
    }
    this.speakerId = peerId;
    this.lastSpeakerId = peerId;
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
        this.mBytesOut += data.length;
      }
    }

    if (!this.provider) return;
    const durationMs = pcmDurationMs(data.length);
    for (const lang of this.listenerLangs(speaker.info.lang)) {
      this.pairStat(`${speaker.info.lang}->${lang}`).inMs += durationMs;
      void this.sessionFor(speaker.info.lang, lang)
        .then((session) => session.appendAudio(encoded()))
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
      onAudio: (chunk) => {
        const speakerId = this.lastSpeakerId;
        if (!speakerId) return;
        const audio = Buffer.from(chunk, "base64");
        this.pairStat(key).outMs += pcmDurationMs(audio.length);
        for (const peer of this.peers.values()) {
          if (peer.info.id !== speakerId && peer.info.lang === targetLang) {
            this.sendBinary(peer.info.id, audio);
            this.mBytesOut += audio.length;
          }
        }
      },
      onTranscript: (text, final) => {
        const speakerId = this.lastSpeakerId;
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
      },
    }, this.timing);
    this.sessions.set(key, session);
    session.catch((error: Error) => {
      console.error(`[babyl] apertura sessione ${key} fallita:`, error.message);
      this.sessions.delete(key);
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
          this.mBytesOut += audio.length;
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
        },
      },
      "consecutive",
    );
    this.sessions.set(key, session);
    session.catch((error: Error) => {
      console.error(`[babyl] apertura sessione ${key} fallita:`, error.message);
      this.sessions.delete(key);
      this.send(peerId, { type: "translation-error" });
    });
    return session;
  }

  destroy(): void {
    for (const session of this.sessions.values()) {
      void session.then((s) => s.close()).catch(() => {});
    }
    this.sessions.clear();
  }

  send(peerId: string, message: ServerMessage): void {
    const peer = this.peers.get(peerId);
    if (peer && peer.socket.readyState === peer.socket.OPEN) {
      peer.socket.send(JSON.stringify(message));
    }
  }

  /** Invia un frame audio binario (PCM16) a un peer. */
  sendBinary(peerId: string, data: Buffer): void {
    const peer = this.peers.get(peerId);
    if (peer && peer.socket.readyState === peer.socket.OPEN) {
      peer.socket.send(data);
    }
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
  leave(roomId: string, peerId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.leave(peerId);
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
