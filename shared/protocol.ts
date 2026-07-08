/**
 * Protocollo di segnalazione Babyl — condiviso tra client (web) e server.
 *
 * Il server è l'autorità sullo stato del canale (Half-Duplex / Push-to-Talk):
 * un solo peer alla volta può detenere il "lock" di trasmissione, prevenendo
 * la collisione di pacchetti audio e la sovrapposizione delle tracce.
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

/** Messaggi client → server. */
export type ClientMessage =
  | { type: "join"; room: string; nickname: string; lang: string }
  | { type: "ptt"; action: "request" | "release" }
  | { type: "signal"; to: string; data: SignalPayload }
  | { type: "leave" };

/** Messaggi server → client. */
export type ServerMessage =
  | { type: "welcome"; self: PeerInfo; peers: PeerInfo[]; channel: ChannelState }
  | { type: "peer-joined"; peer: PeerInfo }
  | { type: "peer-left"; peerId: string }
  | { type: "channel"; channel: ChannelState }
  | { type: "ptt-denied"; reason: "busy" }
  | { type: "signal"; from: string; data: SignalPayload }
  | { type: "error"; message: string };

/** Payload WebRTC inoltrato opacamente dal server tra i peer. */
export type SignalPayload =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

// Tipo strutturale minimo per non dipendere dai lib DOM sul server.
export interface RTCIceCandidateInit {
  candidate?: string;
  sdpMLineIndex?: number | null;
  sdpMid?: string | null;
  usernameFragment?: string | null;
}
