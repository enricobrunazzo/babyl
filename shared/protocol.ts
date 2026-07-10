/**
 * Protocollo di segnalazione e audio Babyl — condiviso tra client e server.
 *
 * Il server è l'autorità sullo stato del canale (Half-Duplex / Push-to-Talk):
 * un solo peer alla volta può detenere il "lock" di trasmissione.
 *
 * L'audio viaggia sempre attraverso il server (niente peer-to-peer): il
 * parlante invia PCM16 mono 24 kHz come **frame WebSocket binari** (niente
 * base64/JSON sul hop client↔server); il server li consegna agli ascoltatori
 * della stessa lingua in originale e li instrada al motore di traduzione per
 * le altre lingue presenti in stanza. Solo i messaggi di controllo qui sotto
 * viaggiano come frame testuali JSON.
 */

/**
 * Modalità della stanza, decisa dal primo che entra:
 * - "conversation": stanza paritaria (default), tutti possono prendere il PTT;
 * - "event": conferenza. Un relatore trasmette a un pubblico che ascolta
 *   tradotto nella propria lingua; il pubblico ha il microfono disabilitato
 *   finché il relatore non concede la parola (Q&A con alzata di mano).
 */
export type RoomMode = "conversation" | "event";

/**
 * Ruolo del partecipante. In "conversation" sono tutti "speaker" (paritari).
 * In "event": "speaker" = relatore (può parlare e concedere la parola),
 * "audience" = pubblico (ascolta; può parlare solo se gli è concessa la parola).
 */
export type PeerRole = "speaker" | "audience";

export interface PeerInfo {
  id: string;
  nickname: string;
  /** Codice lingua BCP-47 base (es. "it", "de", "en") scelto in onboarding. */
  lang: string;
  /** Ruolo in stanza (rilevante in modalità evento). */
  role: PeerRole;
  joinedAt: number;
}

export interface ChannelState {
  /** Peer che detiene il canale, o null se il canale è libero (stato Verde). */
  speakerId: string | null;
  speakerName: string | null;
}

/**
 * Tempistica della traduzione, impostazione di stanza condivisa da tutti i
 * partecipanti:
 * - "streaming": interpretazione simultanea (VAD sulle pause naturali, la
 *   voce tradotta parte mentre il parlante prosegue — effetto interprete TV);
 * - "interview": come streaming ma con pausa di segmentazione più lunga, così
 *   le pause retoriche non frammentano la frase — turni netti, tipo intervista;
 * - "consecutive": la traduzione parte solo al rilascio del PTT (turni puliti,
 *   latenza pari alla durata dell'enunciato).
 */
export const TRANSLATION_TIMINGS = [
  "streaming",
  "interview",
  "consecutive",
] as const;
export type TranslationTiming = (typeof TRANSLATION_TIMINGS)[number];

export interface TranslationInfo {
  enabled: boolean;
  /** Nome del provider attivo, o "off" (voce originale a tutti). */
  provider: string;
  /** Tempistica corrente della stanza (condivisa da tutti i partecipanti). */
  timing: TranslationTiming;
}

/** Messaggi client → server. */
export type ClientMessage =
  | {
      type: "join";
      room: string;
      nickname: string;
      lang: string;
      /** Modalità richiesta (default "conversation"). Il primo che entra fissa
       *  la modalità della stanza; "event" la rende una conferenza. */
      mode?: RoomMode;
      /** Ruolo richiesto (default "speaker"). In evento il pubblico usa "audience". */
      role?: PeerRole;
    }
  | { type: "ptt"; action: "request" | "release" }
  | { type: "update-lang"; lang: string }
  /** Cambia la tempistica della traduzione per l'intera stanza. */
  | { type: "set-timing"; timing: TranslationTiming }
  /** Evento/Q&A: il pubblico alza o abbassa la mano per chiedere di parlare. */
  | { type: "raise-hand"; raised: boolean }
  /** Evento: il relatore concede la parola a un partecipante del pubblico. */
  | { type: "grant-floor"; peerId: string }
  /** Evento: il relatore ritira la parola concessa. */
  | { type: "revoke-floor" }
  /**
   * Modalità single-device (due persone, un telefono): dichiara la direzione
   * di traduzione dell'enunciato corrente. Il parlante dice `source`, il
   * server traduce in `target` e rimanda l'audio allo stesso dispositivo.
   * Inviato all'ingresso e a ogni scambio dei due lati (toggle A⇄B).
   */
  | { type: "solo-config"; source: string; target: string }
  | { type: "leave" };

/** Messaggi server → client. */
export type ServerMessage =
  | {
      type: "welcome";
      self: PeerInfo;
      peers: PeerInfo[];
      channel: ChannelState;
      translation: TranslationInfo;
      /** Modalità effettiva della stanza (conversation/event). */
      mode: RoomMode;
      /** Evento: id dei partecipanti con la mano alzata, in ordine di richiesta. */
      hands: string[];
      /** Evento: id del partecipante a cui è concessa la parola, o null. */
      floor: string | null;
    }
  | { type: "peer-joined"; peer: PeerInfo }
  | { type: "peer-left"; peerId: string }
  | { type: "peer-updated"; peer: PeerInfo }
  | { type: "channel"; channel: ChannelState }
  /** Nuova tempistica della traduzione, valida per tutta la stanza. */
  | { type: "timing"; timing: TranslationTiming }
  /** Evento: coda aggiornata delle mani alzate (id in ordine di richiesta). */
  | { type: "hands"; hands: string[] }
  /** Evento: cambia il partecipante a cui è concessa la parola (o null). */
  | { type: "floor"; floor: string | null }
  | { type: "ptt-denied"; reason: "busy" | "not-granted" }
  /** Sottotitoli live nella lingua del destinatario. */
  | { type: "transcript"; speakerId: string; text: string; final: boolean }
  /**
   * Traduzione temporaneamente non disponibile (es. motore sovraccarico):
   * segnalazione non fatale, la connessione alla stanza resta attiva.
   */
  | { type: "translation-error" }
  | { type: "error"; message: string };
