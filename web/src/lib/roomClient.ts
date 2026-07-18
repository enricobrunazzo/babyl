import type {
  ChannelState,
  ClientMessage,
  PeerInfo,
  PeerRole,
  RoomMode,
  ServerMessage,
  TranslationInfo,
  TranslationTiming,
} from "../../../shared/protocol";
import { floatToPcmBuffer, pcmBufferToFloat, SAMPLE_RATE } from "./pcm";

export type ConnectionStatus =
  | "idle"
  | "mic"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed"
  | "error";

export type PttState = "free" | "talking" | "blocked";

export interface Subtitle {
  speakerId: string;
  text: string;
  final: boolean;
}

/** Metriche diagnostiche lato client, aggiornate ~1/s in modalità debug. */
export interface ClientMetrics {
  /** Byte audio inviati/ricevuti (payload base64 ≈ byte sul filo). */
  upBytes: number;
  downBytes: number;
  /** Banda istantanea (kbit/s) nell'ultimo secondo. */
  upKbps: number;
  downKbps: number;
  /** Latenza inizio-parlante → primo frame audio ricevuto (ms), o null. */
  lastLatencyMs: number | null;
  /** Riserva del jitter buffer di riproduzione (ms in anticipo). */
  jitterMs: number;
  framesReceived: number;
}

export interface RoomState {
  status: ConnectionStatus;
  self: PeerInfo | null;
  peers: PeerInfo[];
  channel: ChannelState;
  translation: TranslationInfo;
  subtitle: Subtitle | null;
  /** Contatore diagnostico dei chunk audio ricevuti (usato anche nei test). */
  audioFramesReceived: number;
  /** Metriche diagnostiche (popolate solo in modalità debug). */
  metrics: ClientMetrics;
  /** Direzione corrente in modalità single-device, o null (modalità stanza). */
  solo: { source: string; target: string } | null;
  /** Traduzione temporaneamente non disponibile (motore sovraccarico). */
  translationError: boolean;
  /** Modalità della stanza: "conversation" (default) o "event" (conferenza). */
  mode: RoomMode;
  /** Ruolo del partecipante: "speaker" (relatore/paritario) o "audience" (pubblico). */
  role: PeerRole;
  /** Evento: id dei partecipanti con la mano alzata, in ordine di richiesta. */
  hands: string[];
  /** Evento: id del partecipante a cui è concessa la parola, o null. */
  floor: string | null;
  /** Evento/pubblico: microfono negato al momento della concessione (Q&A). */
  micGrantDenied: boolean;
  /** Ultima richiesta PTT negata dal server (feedback transitorio), o null. */
  pttDenied: "busy" | "not-granted" | null;
  /** Traduzione in corso di riproduzione: abilita il pulsante "Interrompi". */
  playing: boolean;
  error: "mic-denied" | "connection" | null;
}

export interface RoomOptions {
  url: string;
  room: string;
  nickname: string;
  lang: string;
  /** Abilita il campionamento delle metriche (pannello ?debug=1). */
  debug?: boolean;
  /** Modalità single-device: seconda lingua (la prima è `lang`). */
  soloTarget?: string;
  /** Modalità richiesta al server (default "conversation"). */
  mode?: RoomMode;
  /** Ruolo richiesto (default "speaker"). Il pubblico di un evento usa "audience". */
  role?: PeerRole;
}

const MAX_RECONNECT_ATTEMPTS = 8;
/** ~100 ms di audio per chunk: buon compromesso latenza/overhead. */
const CAPTURE_CHUNK_SAMPLES = 2400;

/**
 * Normalizza un segmento di sottotitolo per confrontarlo con il precedente:
 * minuscolo, spazi compattati e punteggiatura di contorno rimossa, così che
 * "App testing session." e "app testing session" risultino lo stesso segmento
 * ai fini del dedup dei doppioni consecutivi.
 */
function normalizeSegment(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s]+/g, " ")
    .replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "")
    .trim();
}

/**
 * Spezza un testo nelle frasi che lo compongono, conservando la punteggiatura
 * finale. Serve al dedup dei sottotitoli: il motore realtime può ripetere la
 * stessa frase più volte dentro un unico segmento, e confrontarle una a una
 * permette di collassare le ripetizioni consecutive. Un testo senza
 * punteggiatura resta una singola frase.
 */
function splitSentences(text: string): string[] {
  const matches = text.match(/[^.!?]+[.!?]*/g);
  if (!matches) return [];
  return matches.map((sentence) => sentence.trim()).filter(Boolean);
}

/**
 * Client di stanza: WebSocket per segnalazione E audio (half-duplex).
 *
 * Il microfono viene catturato via AudioWorklet a 24 kHz e inviato al server
 * solo mentre il server conferma il lock PTT; l'audio in arrivo (tradotto o
 * voce originale) è PCM16 24 kHz riprodotto via Web Audio. Mentre si
 * trasmette la riproduzione è sospesa per prevenire loop acustici.
 */
export class RoomClient {
  private ws: WebSocket | null = null;
  private localStream: MediaStream | null = null;
  private listeners = new Set<() => void>();
  private disposed = false;
  /** Invalida le connect() in corso quando si riconnette (es. remount React). */
  private generation = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Spegne il feedback "PTT negato" dopo qualche secondo. */
  private pttDeniedTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Chiave di ripresa per-sessione (in memoria: il sistema resta stateless).
   * Alla riconnessione il server riconosce il peer e gli fa riprendere la
   * stessa identità: stesso id nel roster e, in evento, mano alzata e parola
   * concessa conservate.
   */
  private resumeKey =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  // Cattura microfono
  private captureCtx: AudioContext | null = null;
  private transmitting = false;
  private pendingSamples: Float32Array[] = [];
  private pendingLength = 0;

  // Riproduzione
  private playCtx: AudioContext | null = null;
  private playCursor = 0;
  /** Sorgenti audio schedulate ma non ancora terminate: servono a interromperle. */
  private activeSources = new Set<AudioBufferSourceNode>();

  // Metriche diagnostiche (campionate solo in modalità debug).
  private metricsTimer: ReturnType<typeof setInterval> | null = null;
  private upBytes = 0;
  private downBytes = 0;
  private lastUpBytes = 0;
  private lastDownBytes = 0;
  private lastLatencyMs: number | null = null;
  private speakerStartedAt = 0;
  private awaitingFirstFrame = false;

  // Sottotitoli: in modalità simultanea un enunciato produce più segmenti
  // tradotti; i testi finali si accumulano, il parziale corrente si appende.
  private subtitleFinal = "";
  private subtitlePartial = "";
  // Ultimo segmento finale accodato, normalizzato: serve a scartare i doppioni
  // consecutivi quando il motore realtime va in loop e ritraduce lo stesso
  // segmento più volte (vedi dedup nel gestore "transcript").
  private lastFinalSegment = "";

  private state: RoomState = {
    status: "idle",
    self: null,
    peers: [],
    channel: { speakerId: null, speakerName: null },
    translation: { enabled: false, provider: "off", timing: "streaming" },
    subtitle: null,
    audioFramesReceived: 0,
    metrics: {
      upBytes: 0,
      downBytes: 0,
      upKbps: 0,
      downKbps: 0,
      lastLatencyMs: null,
      jitterMs: 0,
      framesReceived: 0,
    },
    solo: null,
    translationError: false,
    mode: "conversation",
    role: "speaker",
    hands: [],
    floor: null,
    micGrantDenied: false,
    pttDenied: null,
    playing: false,
    error: null,
  };

  constructor(private opts: RoomOptions) {
    if (opts.soloTarget) {
      this.state.solo = { source: opts.lang, target: opts.soloTarget };
    }
    this.state.mode = opts.mode ?? "conversation";
    this.state.role = opts.role ?? "speaker";
  }

  /** Il pubblico di un evento ascolta soltanto finché non gli è concessa la parola. */
  private get listenOnly(): boolean {
    return this.opts.role === "audience";
  }

  getState = (): RoomState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setState(patch: Partial<RoomState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  async connect(): Promise<void> {
    const generation = ++this.generation;
    this.disposed = false;

    // Pubblico di un evento: nessun microfono all'ingresso (ascolto puro). Lo
    // si attiva pigramente solo se il relatore concede la parola (Q&A).
    if (!this.listenOnly) {
      this.setState({ status: "mic" });
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch {
        if (generation === this.generation) {
          this.setState({ status: "error", error: "mic-denied" });
        }
        return;
      }
      if (this.disposed || generation !== this.generation) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.localStream = stream;

      try {
        await this.initCapture(stream);
      } catch (error) {
        console.warn("[babyl] inizializzazione cattura audio fallita", error);
      }
      if (this.disposed || generation !== this.generation) return;
    }

    this.setState({ status: "connecting" });
    if (this.opts.debug) this.startMetrics();
    // Rientro in primo piano o rete tornata: su mobile il socket muore spesso
    // senza evento close mentre lo schermo è bloccato; questi segnali fanno
    // riprendere audio e connessione subito, senza aspettare il backoff.
    document.addEventListener("visibilitychange", this.handleWake);
    window.addEventListener("online", this.handleWake);
    this.openSocket();
  }

  /**
   * Al ritorno in primo piano (o al ripristino della rete) riattiva i context
   * audio sospesi dal browser e, se il socket è morto nel frattempo, riconnette
   * immediatamente azzerando il backoff: il rientro è un gesto dell'utente.
   */
  private handleWake = (): void => {
    if (this.disposed || document.visibilityState !== "visible") return;
    void this.captureCtx?.resume().catch(() => {});
    void this.playCtx?.resume().catch(() => {});
    // Prima del join iniziale (status idle/mic/connecting/error) non c'è nulla
    // da riconnettere: ci pensa il flusso di connect() in corso.
    const status = this.state.status;
    if (status !== "connected" && status !== "reconnecting" && status !== "closed") {
      return;
    }
    const socketAlive =
      this.ws !== null &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING);
    if (socketAlive) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.setState({ error: null });
    this.openSocket();
  };

  /**
   * Attiva il microfono su richiesta: usato dal pubblico di un evento quando gli
   * viene concessa la parola. Idempotente; se il permesso è negato lo segnala
   * senza cadere dalla stanza (resta comunque in ascolto).
   */
  private async ensureCapture(): Promise<void> {
    if (this.localStream) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      this.setState({ micGrantDenied: true });
      return;
    }
    if (this.disposed) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.localStream = stream;
    try {
      await this.initCapture(stream);
    } catch (error) {
      console.warn("[babyl] inizializzazione cattura audio fallita", error);
    }
  }

  /**
   * Segnale acustico locale "pronto" quando viene concessa la parola: due brevi
   * note ascendenti generate con Web Audio. Neutro rispetto alla lingua e più
   * discreto della voce sintetizzata di prima. L'avviso testuale in UI resta.
   */
  private announceMicOn(): void {
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      // Riusa il contesto di riproduzione (già sbloccato); se manca ne crea uno
      // temporaneo solo per il suono e lo chiude dopo.
      const owned = !this.playCtx;
      const ctx = this.playCtx ?? (Ctx ? new Ctx() : null);
      if (!ctx) return;
      void ctx.resume?.().catch(() => {});
      const now = ctx.currentTime;
      const beep = (freq: number, at: number, dur: number) => {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, now + at);
        gain.gain.exponentialRampToValueAtTime(0.18, now + at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + at);
        osc.stop(now + at + dur + 0.02);
      };
      beep(660, 0, 0.13);
      beep(990, 0.13, 0.18);
      if (owned) window.setTimeout(() => void ctx.close().catch(() => {}), 600);
    } catch {
      // Audio non disponibile: l'avviso testuale in UI resta comunque.
    }
  }

  /** Campiona banda e jitter ~1/s (solo in modalità debug). */
  private startMetrics(): void {
    if (this.metricsTimer !== null) return;
    this.metricsTimer = setInterval(() => {
      const upKbps = (this.upBytes - this.lastUpBytes) * 8 / 1000;
      const downKbps = (this.downBytes - this.lastDownBytes) * 8 / 1000;
      this.lastUpBytes = this.upBytes;
      this.lastDownBytes = this.downBytes;
      const jitterMs = this.playCtx
        ? Math.max(0, (this.playCursor - this.playCtx.currentTime) * 1000)
        : 0;
      this.setState({
        metrics: {
          upBytes: this.upBytes,
          downBytes: this.downBytes,
          upKbps: Math.round(upKbps),
          downKbps: Math.round(downKbps),
          lastLatencyMs: this.lastLatencyMs,
          jitterMs: Math.round(jitterMs),
          framesReceived: this.state.audioFramesReceived,
        },
      });
    }, 1000);
  }

  /** Cattura a 24 kHz: il browser ricampiona il microfono per noi. */
  private async initCapture(stream: MediaStream): Promise<void> {
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.captureCtx = ctx;
    await ctx.audioWorklet.addModule("/pcm-capture-worklet.js");
    const source = ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(ctx, "pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
    worklet.port.onmessage = (event) => {
      this.onCaptureFrame(event.data as Float32Array);
    };
    // Uscita silenziata: serve solo a mantenere attivo il nodo nel grafo.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(worklet);
    worklet.connect(mute);
    mute.connect(ctx.destination);
  }

  private onCaptureFrame(frame: Float32Array): void {
    if (!this.transmitting) return;
    this.pendingSamples.push(frame);
    this.pendingLength += frame.length;
    if (this.pendingLength >= CAPTURE_CHUNK_SAMPLES) this.flushCapture();
  }

  private flushCapture(): void {
    if (this.pendingLength === 0) return;
    const merged = new Float32Array(this.pendingLength);
    let offset = 0;
    for (const chunk of this.pendingSamples) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.pendingSamples = [];
    this.pendingLength = 0;
    const buffer = floatToPcmBuffer(merged);
    this.upBytes += buffer.byteLength;
    // Frame binario: niente base64/JSON sul hop verso il server.
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buffer);
  }

  private openSocket(): void {
    this.setState({
      status: this.reconnectAttempts > 0 ? "reconnecting" : "connecting",
    });
    const ws = new WebSocket(this.opts.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.send({
        type: "join",
        room: this.opts.room,
        nickname: this.opts.nickname,
        lang: this.opts.lang,
        mode: this.opts.mode,
        role: this.opts.role,
        resumeKey: this.resumeKey,
      });
    };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        this.handleMessage(JSON.parse(event.data) as ServerMessage);
      } else {
        this.handleAudioFrame(event.data as ArrayBuffer);
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (!this.disposed) this.scheduleReconnect();
    };
    // Gli errori di rete producono comunque un evento close: è lì che si
    // decide se ritentare, quindi qui non serve cambiare stato.
    ws.onerror = () => {};
  }

  /** Riconnessione con backoff esponenziale (rete mobile instabile). */
  private scheduleReconnect(): void {
    this.setTransmitting(false);
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.setState({ status: "closed", error: "connection" });
      return;
    }
    const delay = Math.min(500 * 2 ** this.reconnectAttempts, 8000);
    this.reconnectAttempts += 1;
    this.setState({
      status: "reconnecting",
      peers: [],
      channel: { speakerId: null, speakerName: null },
      subtitle: null,
    });
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }

  disconnect(): void {
    this.disposed = true;
    document.removeEventListener("visibilitychange", this.handleWake);
    window.removeEventListener("online", this.handleWake);
    if (this.metricsTimer !== null) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pttDeniedTimer !== null) {
      clearTimeout(this.pttDeniedTimer);
      this.pttDeniedTimer = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({ type: "leave" });
    }
    this.ws?.close();
    this.ws = null;
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    this.localStream = null;
    void this.captureCtx?.close().catch(() => {});
    this.captureCtx = null;
    void this.playCtx?.close().catch(() => {});
    this.playCtx = null;
  }

  /** Richiede il lock del canale (pressione del pulsante PTT). */
  pttDown(): void {
    // I context audio partono sospesi finché non c'è un gesto utente.
    void this.captureCtx?.resume().catch(() => {});
    void this.playCtx?.resume().catch(() => {});
    this.send({ type: "ptt", action: "request" });
  }

  /** Rilascia il lock del canale (rilascio del pulsante PTT). */
  pttUp(): void {
    this.flushCapture();
    this.send({ type: "ptt", action: "release" });
  }

  /**
   * Annulla l'enunciato: rilascia il canale scartando l'audio (non ancora
   * inviato) senza tradurlo. Utile per rifare un enunciato sporcato senza
   * sprecare token — in consecutiva la traduzione parte solo al rilascio.
   */
  pttCancel(): void {
    // Butta i campioni pendenti invece di inviarli, poi chiedi al server di
    // scartare quanto già accumulato per questo enunciato.
    this.pendingSamples = [];
    this.pendingLength = 0;
    this.send({ type: "ptt", action: "cancel" });
  }

  /**
   * Interrompe la traduzione: ferma subito la riproduzione locale e, in
   * single-device, annulla anche la generazione lato motore (token risparmiati:
   * l'utente non deve ascoltare fino in fondo). In stanza si limita a fermare
   * la propria riproduzione, senza toccare la sessione condivisa degli altri.
   */
  interruptTranslation(): void {
    this.stopPlayback();
    if (this.state.solo) this.send({ type: "stop-translation" });
  }

  /** Ferma tutte le sorgenti audio in riproduzione/schedulate e azzera la coda. */
  private stopPlayback(): void {
    for (const source of this.activeSources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Già ferma o non ancora avviata: ignora.
      }
    }
    this.activeSources.clear();
    this.playCursor = this.playCtx?.currentTime ?? 0;
    this.setState({ playing: false });
  }

  updateLanguage(lang: string): void {
    this.send({ type: "update-lang", lang });
    this.setState({
      self: this.state.self ? { ...this.state.self, lang } : this.state.self,
    });
  }

  /**
   * Imposta il lato che parla in single-device scegliendo la lingua sorgente;
   * la destinazione è l'altra lingua della coppia. No-op se è già la sorgente.
   */
  setSoloSource(lang: string): void {
    const solo = this.state.solo;
    if (!solo || solo.source === lang) return;
    const target = lang === solo.target ? solo.source : solo.target;
    const next = { source: lang, target };
    this.send({ type: "solo-config", ...next });
    this.setState({ solo: next });
  }

  /** Cambia la tempistica della traduzione (impostazione di stanza). */
  setTiming(timing: TranslationTiming): void {
    this.send({ type: "set-timing", timing });
    // Aggiornamento ottimistico: il broadcast "timing" del server conferma.
    this.setState({ translation: { ...this.state.translation, timing } });
  }

  pttState(): PttState {
    const { channel, self } = this.state;
    if (channel.speakerId === null) return "free";
    return channel.speakerId === self?.id ? "talking" : "blocked";
  }

  private send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "welcome": {
        this.setState({
          status: "connected",
          self: message.self,
          peers: message.peers,
          channel: message.channel,
          translation: message.translation,
          mode: message.mode,
          role: message.self.role,
          hands: message.hands,
        });
        // Applica la parola concessa (gestisce anche la riconnessione a metà Q&A).
        this.applyFloor(message.floor);
        // Single-device: comunica subito la direzione di traduzione al server.
        if (this.state.solo) {
          this.send({ type: "solo-config", ...this.state.solo });
        }
        break;
      }
      case "peer-joined": {
        this.setState({ peers: [...this.state.peers, message.peer] });
        break;
      }
      case "peer-left": {
        this.setState({
          peers: this.state.peers.filter((p) => p.id !== message.peerId),
        });
        break;
      }
      case "peer-updated": {
        this.setState({
          self:
            this.state.self?.id === message.peer.id
              ? message.peer
              : this.state.self,
          peers: this.state.peers.map((p) =>
            p.id === message.peer.id ? message.peer : p,
          ),
        });
        break;
      }
      case "channel": {
        this.applyChannel(message.channel);
        break;
      }
      case "timing": {
        this.setState({
          translation: { ...this.state.translation, timing: message.timing },
        });
        break;
      }
      case "hands": {
        this.setState({ hands: message.hands });
        break;
      }
      case "floor": {
        this.applyFloor(message.floor);
        break;
      }
      case "ptt-denied": {
        // Feedback transitorio: spiega perché la pressione non ha aperto il
        // canale (occupato, oppure pubblico senza parola concessa). Il
        // broadcast "channel" tiene comunque la UI in stato Bloccato.
        try {
          navigator.vibrate?.(80);
        } catch {
          // Vibrazione non disponibile: resta il feedback visivo.
        }
        if (this.pttDeniedTimer !== null) clearTimeout(this.pttDeniedTimer);
        this.pttDeniedTimer = setTimeout(() => {
          this.pttDeniedTimer = null;
          this.setState({ pttDenied: null });
        }, 2500);
        this.setState({ pttDenied: message.reason });
        break;
      }
      case "transcript": {
        if (this.state.subtitle?.speakerId !== message.speakerId) {
          this.subtitleFinal = "";
          this.subtitlePartial = "";
          this.lastFinalSegment = "";
        }
        if (message.final) {
          // Il motore realtime a volte va in loop e ripete la stessa frase
          // molte volte — sia entro un singolo segmento finale sia su segmenti
          // consecutivi (tipico con l'audio sovrapposto che il VAD richiude
          // sulle pause brevi). Senza dedup il sottotitolo diventa un muro di
          // ripetizioni ("App testing session. App testing session. …"). Si
          // scartano le frasi identiche consecutive, confrontandole anche con
          // l'ultima frase già accodata dal segmento precedente.
          const kept: string[] = [];
          for (const sentence of splitSentences(message.text)) {
            const normalized = normalizeSegment(sentence);
            if (!normalized || normalized === this.lastFinalSegment) continue;
            kept.push(sentence);
            this.lastFinalSegment = normalized;
          }
          if (kept.length > 0) {
            this.subtitleFinal = `${this.subtitleFinal} ${kept.join(" ")}`.trim();
          }
          this.subtitlePartial = "";
        } else {
          this.subtitlePartial += message.text;
        }
        this.setState({
          subtitle: {
            speakerId: message.speakerId,
            text: `${this.subtitleFinal} ${this.subtitlePartial}`.trim(),
            final: message.final,
          },
        });
        break;
      }
      case "translation-error": {
        this.setState({ translationError: true });
        break;
      }
      case "error": {
        this.setState({ status: "error", error: "connection" });
        break;
      }
    }
  }

  /**
   * Applica la parola concessa (evento/Q&A). Alla transizione "concessa a me"
   * annuncia a voce "microfono abilitato" e attiva pigramente il microfono.
   */
  private applyFloor(floor: string | null): void {
    const selfId = this.state.self?.id;
    const wasMine = this.state.floor === selfId && selfId != null;
    const nowMine = floor != null && floor === selfId;
    this.setState({ floor, micGrantDenied: nowMine ? this.state.micGrantDenied : false });
    if (nowMine && !wasMine) {
      this.announceMicOn();
      void this.ensureCapture();
    }
  }

  /** Evento/Q&A: il pubblico alza o abbassa la mano per chiedere la parola. */
  raiseHand(raised: boolean): void {
    this.send({ type: "raise-hand", raised });
  }

  /** Evento: il relatore concede la parola a un partecipante del pubblico. */
  grantFloor(peerId: string): void {
    this.send({ type: "grant-floor", peerId });
  }

  /** Evento: il relatore ritira la parola concessa (chiude il turno del Q&A). */
  revokeFloor(): void {
    this.send({ type: "revoke-floor" });
  }

  private applyChannel(channel: ChannelState): void {
    const startingUtterance =
      channel.speakerId !== null &&
      channel.speakerId !== this.state.channel.speakerId;
    if (startingUtterance) {
      // Nuovo parlante: via i sottotitoli dell'enunciato precedente.
      this.subtitleFinal = "";
      this.subtitlePartial = "";
      this.lastFinalSegment = "";
      // Avvia il cronometro latenza se a parlare è un altro peer.
      if (channel.speakerId !== this.state.self?.id) {
        this.speakerStartedAt = performance.now();
        this.awaitingFirstFrame = true;
      }
    }
    const gotChannel = channel.speakerId === this.state.self?.id;
    if (gotChannel && this.pttDeniedTimer !== null) {
      clearTimeout(this.pttDeniedTimer);
      this.pttDeniedTimer = null;
    }
    this.setState({
      channel,
      subtitle: startingUtterance ? null : this.state.subtitle,
      // Nuovo enunciato = nuovo tentativo: azzera l'avviso di traduzione ko.
      translationError: startingUtterance ? false : this.state.translationError,
      // Canale ottenuto: l'eventuale feedback "negato" non è più attuale.
      pttDenied: gotChannel ? null : this.state.pttDenied,
    });
    this.setTransmitting(channel.speakerId === this.state.self?.id);
  }

  private setTransmitting(value: boolean): void {
    if (this.transmitting === value) return;
    this.transmitting = value;
    if (!value) {
      this.pendingSamples = [];
      this.pendingLength = 0;
    }
  }

  /** Frame audio binario in arrivo (tradotto o voce originale). */
  private handleAudioFrame(buffer: ArrayBuffer): void {
    this.downBytes += buffer.byteLength;
    // Primo frame dopo l'inizio del parlante altrui: fissa la latenza.
    if (this.awaitingFirstFrame) {
      this.lastLatencyMs = Math.round(performance.now() - this.speakerStartedAt);
      this.awaitingFirstFrame = false;
    }
    this.setState({
      audioFramesReceived: this.state.audioFramesReceived + 1,
    });
    if (!this.transmitting) this.enqueuePlayback(buffer);
  }

  private enqueuePlayback(frame: ArrayBuffer): void {
    const samples = pcmBufferToFloat(frame);
    if (samples.length === 0) return;
    if (!this.playCtx) {
      this.playCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      this.playCursor = 0;
    }
    const ctx = this.playCtx;
    void ctx.resume().catch(() => {});
    const audioBuffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    audioBuffer.getChannelData(0).set(samples);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    // Traccia la sorgente per poterla interrompere; quando l'ultima termina
    // naturalmente, la riproduzione è finita.
    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
      if (this.activeSources.size === 0 && this.state.playing) {
        this.setState({ playing: false });
      }
    };
    // Piccolo jitter buffer, poi accodamento senza interruzioni.
    const startAt = Math.max(ctx.currentTime + 0.05, this.playCursor);
    source.start(startAt);
    this.playCursor = startAt + audioBuffer.duration;
    if (!this.state.playing) this.setState({ playing: true });
  }
}
