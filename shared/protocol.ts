/**
 * Protocollo di segnalazione e audio Babyl — condiviso tra client e server.
 *
 * Il server è l'autorità sullo stato del canale (Half-Duplex / Push-to-Talk):
 * un solo peer alla volta può detenere il "lock" di trasmissione.
 *
 * L'audio viaggia sempre attraverso il server (niente peer-to-peer): il
 * parlante invia PCM16 mono 24 kHz in base64; il server lo consegna agli
 * ascoltatori della stessa lingua in originale e lo instrada al motore di
 * traduzione per le altre lingue presenti in stanza.
 */

export interface PeerInfo {
  id: string;
  nickname: string;
  /** Codice lingua BCP-47 base (es. "it", "de", "en") scelto in onboarding. */
  lang: string;
  joinedAt: number;
}

export interface ChannelState {
  /** Peer che detiene il canale, o null se il canale è libero (stato Verde). */
  speakerId: string | null;
  speakerName: string | null;
}

export interface TranslationInfo {
  enabled: boolean;
  /** Nome del provider attivo, o "off" (voce originale a tutti). */
  provider: string;
}

/** Messaggi client → server. */
export type ClientMessage =
  | { type: "join"; room: string; nickname: string; lang: string }
  | { type: "ptt"; action: "request" | "release" }
  /** Chunk audio del parlante: PCM16 mono 24 kHz, base64. */
  | { type: "audio"; data: string }
  | { type: "leave" };

/** Messaggi server → client. */
export type ServerMessage =
  | {
      type: "welcome";
      self: PeerInfo;
      peers: PeerInfo[];
      channel: ChannelState;
      translation: TranslationInfo;
    }
  | { type: "peer-joined"; peer: PeerInfo }
  | { type: "peer-left"; peerId: string }
  | { type: "channel"; channel: ChannelState }
  | { type: "ptt-denied"; reason: "busy" }
  /** Audio in arrivo, già nella lingua del destinatario (o voce originale). */
  | { type: "audio"; speakerId: string; data: string }
  /** Sottotitoli live nella lingua del destinatario. */
  | { type: "transcript"; speakerId: string; text: string; final: boolean }
  | { type: "error"; message: string };
