import type {
  ChannelState,
  ClientMessage,
  PeerInfo,
  ServerMessage,
  TranslationInfo,
} from "../../../shared/protocol";
import { base64PcmToFloat, floatToBase64Pcm, SAMPLE_RATE } from "./pcm";

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

export interface RoomState {
  status: ConnectionStatus;
  self: PeerInfo | null;
  peers: PeerInfo[];
  channel: ChannelState;
  translation: TranslationInfo;
  subtitle: Subtitle | null;
  /** Contatore diagnostico dei chunk audio ricevuti (usato anche nei test). */
  audioFramesReceived: number;
  error: "mic-denied" | "connection" | null;
}

export interface RoomOptions {
  url: string;
  room: string;
  nickname: string;
  lang: string;
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

  private state: RoomState = {
    status: "idle",
    self: null,
    peers: [],
    channel: { speakerId: null, speakerName: null },
    translation: { enabled: false, provider: "off" },
    subtitle: null,
    audioFramesReceived: 0,
    error: null,
  };

  constructor(private opts: RoomOptions) {}

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
    this.openSocket();
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
    this.send({ type: "audio", data: floatToBase64Pcm(merged) });
  }

  private openSocket(): void {
    this.setState({
      status: this.reconnectAttempts > 0 ? "reconnecting" : "connecting",
    });
    const ws = new WebSocket(this.opts.url);
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
      this.handleMessage(JSON.parse(event.data) as ServerMessage);
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
      case "channel": {
        this.applyChannel(message.channel);
        break;
      }
      case "ptt-denied": {
        // Nessuna azione: il broadcast "channel" tiene già la UI in stato
        // Bloccato (grigio) per tutti i non-parlanti.
        break;
      }
      case "audio": {
        this.setState({
          audioFramesReceived: this.state.audioFramesReceived + 1,
        });
        if (!this.transmitting) this.enqueuePlayback(message.data);
        break;
      }
      case "transcript": {
        this.setState({
          subtitle: {
            speakerId: message.speakerId,
            // I delta parziali si accumulano; il testo finale li sostituisce.
            text: message.final
              ? message.text
              : this.partialSubtitleText(message.speakerId) + message.text,
            final: message.final,
          },
        });
        break;
      }
      case "error": {
        this.setState({ status: "error", error: "connection" });
        break;
      }
    }
  }

  private partialSubtitleText(speakerId: string): string {
    const current = this.state.subtitle;
    if (current && !current.final && current.speakerId === speakerId) {
      return current.text;
    }
    return "";
  }

  private applyChannel(channel: ChannelState): void {
    const startingUtterance =
      channel.speakerId !== null &&
      channel.speakerId !== this.state.channel.speakerId;
    this.setState({
      channel,
      // Nuovo parlante: via i sottotitoli dell'enunciato precedente.
      subtitle: startingUtterance ? null : this.state.subtitle,
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

  private enqueuePlayback(base64: string): void {
    const samples = base64PcmToFloat(base64);
    if (samples.length === 0) return;
    if (!this.playCtx) {
      this.playCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      this.playCursor = 0;
    }
    const ctx = this.playCtx;
    void ctx.resume().catch(() => {});
    const buffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    // Piccolo jitter buffer, poi accodamento senza interruzioni.
    const startAt = Math.max(ctx.currentTime + 0.05, this.playCursor);
    source.start(startAt);
    this.playCursor = startAt + buffer.duration;
  }
}
