import type {
  ChannelState,
  ClientMessage,
  PeerInfo,
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
}

const MAX_RECONNECT_ATTEMPTS = 8;
/** ~100 ms di audio per chunk: buon compromesso latenza/overhead. */
const CAPTURE_CHUNK_SAMPLES = 2400;

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

  // Cattura microfono
  private captureCtx: AudioContext | null = null;
  private transmitting = false;
  private pendingSamples: Float32Array[] = [];
  private pendingLength = 0;

  // Riproduzione
  private playCtx: AudioContext | null = null;
  private playCursor = 0;

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
    error: null,
  };

  constructor(private opts: RoomOptions) {
    if (opts.soloTarget) {
      this.state.solo = { source: opts.lang, target: opts.soloTarget };
    }
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

    this.setState({ status: "connecting" });
    if (this.opts.debug) this.startMetrics();
    this.openSocket();
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
    if (this.metricsTimer !== null) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
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

  updateLanguage(lang: string): void {
    this.send({ type: "update-lang", lang });
    this.setState({
      self: this.state.self ? { ...this.state.self, lang } : this.state.self,
    });
  }

  /** Scambia i due lati della conversazione single-device (toggle A⇄B). */
  toggleSolo(): void {
    const solo = this.state.solo;
    if (!solo) return;
    const swapped = { source: solo.target, target: solo.source };
    this.send({ type: "solo-config", ...swapped });
    this.setState({ solo: swapped });
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
        });
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
      case "ptt-denied": {
        // Nessuna azione: il broadcast "channel" tiene già la UI in stato
        // Bloccato (grigio) per tutti i non-parlanti.
        break;
      }
      case "transcript": {
        if (this.state.subtitle?.speakerId !== message.speakerId) {
          this.subtitleFinal = "";
          this.subtitlePartial = "";
        }
        if (message.final) {
          this.subtitleFinal = `${this.subtitleFinal} ${message.text}`.trim();
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

  private applyChannel(channel: ChannelState): void {
    const startingUtterance =
      channel.speakerId !== null &&
      channel.speakerId !== this.state.channel.speakerId;
    if (startingUtterance) {
      // Nuovo parlante: via i sottotitoli dell'enunciato precedente.
      this.subtitleFinal = "";
      this.subtitlePartial = "";
      // Avvia il cronometro latenza se a parlare è un altro peer.
      if (channel.speakerId !== this.state.self?.id) {
        this.speakerStartedAt = performance.now();
        this.awaitingFirstFrame = true;
      }
    }
    this.setState({
      channel,
      subtitle: startingUtterance ? null : this.state.subtitle,
      // Nuovo enunciato = nuovo tentativo: azzera l'avviso di traduzione ko.
      translationError: startingUtterance ? false : this.state.translationError,
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
    // Piccolo jitter buffer, poi accodamento senza interruzioni.
    const startAt = Math.max(ctx.currentTime + 0.05, this.playCursor);
    source.start(startAt);
    this.playCursor = startAt + audioBuffer.duration;
  }
}
