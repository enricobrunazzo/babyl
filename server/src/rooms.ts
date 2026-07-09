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

  /** Concede il lock solo se il canale è libero (o già del richiedente). */
  requestLock(peerId: string): void {
    if (this.speakerId !== null && this.speakerId !== peerId) {
      this.send(peerId, { type: "ptt-denied", reason: "busy" });
      return;
    }
    this.speakerId = peerId;
    this.lastSpeakerId = peerId;
    this.broadcast({ type: "channel", channel: this.channel });
  }

  releaseLock(peerId: string): void {
    if (this.speakerId !== peerId) return;
    this.speakerId = null;
    this.commitUtterance();
    this.broadcast({ type: "channel", channel: this.channel });
  }

  /** Chunk audio dal parlante (PCM16 24 kHz base64). */
  handleAudio(peerId: string, data: string): void {
    if (peerId !== this.speakerId) return; // solo chi detiene il lock
    const speaker = this.peers.get(peerId);
    if (!speaker) return;

    for (const peer of this.peers.values()) {
      if (peer.info.id === peerId) continue;
      // Voce originale a chi parla la stessa lingua (o a tutti senza provider).
      if (!this.provider || peer.info.lang === speaker.info.lang) {
        this.send(peer.info.id, { type: "audio", speakerId: peerId, data });
      }
    }

    if (!this.provider) return;
    for (const lang of this.listenerLangs(speaker.info.lang)) {
      void this.sessionFor(speaker.info.lang, lang)
        .then((session) => session.appendAudio(data))
        .catch(() => {});
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
        for (const peer of this.peers.values()) {
          if (peer.info.id !== speakerId && peer.info.lang === targetLang) {
            this.send(peer.info.id, {
              type: "audio",
              speakerId,
              data: chunk,
            });
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

export class RoomManager {
  private rooms = new Map<string, Room>();

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
      room.destroy();
      this.rooms.delete(roomId);
    }
  }
}
