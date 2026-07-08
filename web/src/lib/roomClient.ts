import type {
  ChannelState,
  ClientMessage,
  PeerInfo,
  ServerMessage,
  SignalPayload,
} from "../../../shared/protocol";

export type ConnectionStatus =
  | "idle"
  | "mic"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed"
  | "error";

export type PttState = "free" | "talking" | "blocked";

export interface RoomState {
  status: ConnectionStatus;
  self: PeerInfo | null;
  peers: PeerInfo[];
  channel: ChannelState;
  error: "mic-denied" | "connection" | null;
}

export interface RoomOptions {
  url: string;
  room: string;
  nickname: string;
  lang: string;
}

/**
 * ICE server configurabili via VITE_ICE_SERVERS (array JSON, es. per TURN:
 * [{"urls":"turn:turn.babyl.it:3478","username":"u","credential":"c"}]).
 * Default: solo STUN pubblico, sufficiente per NAT non restrittivi.
 */
function iceServers(): RTCIceServer[] {
  const raw = import.meta.env.VITE_ICE_SERVERS as string | undefined;
  if (raw) {
    try {
      return JSON.parse(raw) as RTCIceServer[];
    } catch {
      console.warn("[babyl] VITE_ICE_SERVERS non è JSON valido, uso default");
    }
  }
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

const MAX_RECONNECT_ATTEMPTS = 8;

/**
 * Client di stanza: WebSocket di segnalazione + mesh WebRTC audio.
 *
 * Half-Duplex: la traccia microfono locale esiste sempre sulle connessioni
 * (nessuna rinegoziazione al PTT) ma è abilitata solo quando il server
 * concede il lock. Mentre si trasmette, gli stream in ricezione vengono
 * silenziati per prevenire loop acustici.
 */
export class RoomClient {
  private ws: WebSocket | null = null;
  private pcs = new Map<string, RTCPeerConnection>();
  private audioEls = new Map<string, HTMLAudioElement>();
  private pendingIce = new Map<string, RTCIceCandidateInit[]>();
  private localStream: MediaStream | null = null;
  private listeners = new Set<() => void>();
  private disposed = false;
  /** Invalida le connect() in corso quando si riconnette (es. remount React). */
  private generation = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private state: RoomState = {
    status: "idle",
    self: null,
    peers: [],
    channel: { speakerId: null, speakerName: null },
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
    // connect() superata da una successiva (o disconnect): abbandona.
    if (this.disposed || generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.localStream = stream;
    // Il microfono resta muto finché il server non concede il lock PTT.
    for (const track of stream.getAudioTracks()) {
      track.enabled = false;
    }

    this.openSocket();
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
      void this.handleMessage(JSON.parse(event.data) as ServerMessage);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (!this.disposed) this.scheduleReconnect();
    };
    // Gli errori di rete producono comunque un evento close: è lì che si
    // decide se ritentare, quindi qui non serve cambiare stato.
    ws.onerror = () => {};
  }

  /**
   * Riconnessione con backoff esponenziale (rete mobile instabile).
   * La mesh WebRTC viene ricostruita da zero al rientro: il server assegna
   * un nuovo peerId e rimanda welcome con il roster corrente.
   */
  private scheduleReconnect(): void {
    for (const peerId of [...this.pcs.keys()]) this.closePeer(peerId);
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
    for (const peerId of [...this.pcs.keys()]) this.closePeer(peerId);
    this.stopLocalStream();
  }

  /** Richiede il lock del canale (pressione del pulsante PTT). */
  pttDown(): void {
    this.send({ type: "ptt", action: "request" });
  }

  /** Rilascia il lock del canale (rilascio del pulsante PTT). */
  pttUp(): void {
    this.send({ type: "ptt", action: "release" });
  }

  /** Stato delle connessioni WebRTC verso i peer (diagnostica). */
  connectionStates(): Record<string, RTCPeerConnectionState> {
    return Object.fromEntries(
      [...this.pcs].map(([id, pc]) => [id, pc.connectionState]),
    );
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

  private async handleMessage(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case "welcome": {
        this.setState({
          status: "connected",
          self: message.self,
          peers: message.peers,
          channel: message.channel,
        });
        // Il nuovo arrivato apre le connessioni verso i peer già presenti:
        // un solo lato inizia la negoziazione, quindi niente glare SDP.
        for (const peer of message.peers) {
          await this.createPeer(peer.id, true);
        }
        break;
      }
      case "peer-joined": {
        this.setState({ peers: [...this.state.peers, message.peer] });
        break;
      }
      case "peer-left": {
        this.closePeer(message.peerId);
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
      case "signal": {
        await this.handleSignal(message.from, message.data);
        break;
      }
      case "error": {
        this.setState({ status: "error", error: "connection" });
        break;
      }
    }
  }

  private applyChannel(channel: ChannelState): void {
    this.setState({ channel });
    const transmitting = channel.speakerId === this.state.self?.id;
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = transmitting;
    }
    for (const el of this.audioEls.values()) {
      el.muted = transmitting;
    }
  }

  private async createPeer(
    peerId: string,
    initiator: boolean,
  ): Promise<RTCPeerConnection> {
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    this.pcs.set(peerId, pc);
    for (const track of this.localStream?.getTracks() ?? []) {
      pc.addTrack(track, this.localStream!);
    }
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(peerId, {
          kind: "ice",
          candidate: event.candidate.toJSON(),
        });
      }
    };
    pc.ontrack = (event) => {
      this.attachRemoteStream(peerId, event.streams[0]);
    };
    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendSignal(peerId, { kind: "offer", sdp: offer.sdp! });
    }
    return pc;
  }

  private async handleSignal(
    from: string,
    data: SignalPayload,
  ): Promise<void> {
    try {
      if (data.kind === "offer") {
        const pc = this.pcs.get(from) ?? (await this.createPeer(from, false));
        await pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
        await this.flushPendingIce(from, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.sendSignal(from, { kind: "answer", sdp: answer.sdp! });
      } else if (data.kind === "answer") {
        const pc = this.pcs.get(from);
        if (!pc) return;
        await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
        await this.flushPendingIce(from, pc);
      } else if (data.kind === "ice") {
        const pc = this.pcs.get(from);
        if (pc?.remoteDescription) {
          await pc.addIceCandidate(data.candidate as RTCIceCandidateInit);
        } else {
          // Trickle ICE arrivato prima della descrizione remota: in coda.
          const queue = this.pendingIce.get(from) ?? [];
          queue.push(data.candidate as RTCIceCandidateInit);
          this.pendingIce.set(from, queue);
        }
      }
    } catch (error) {
      console.warn("[babyl] errore segnalazione WebRTC", error);
    }
  }

  private async flushPendingIce(
    peerId: string,
    pc: RTCPeerConnection,
  ): Promise<void> {
    const queue = this.pendingIce.get(peerId);
    if (!queue) return;
    this.pendingIce.delete(peerId);
    for (const candidate of queue) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        console.warn("[babyl] candidato ICE scartato", error);
      }
    }
  }

  private sendSignal(to: string, data: SignalPayload): void {
    this.send({ type: "signal", to, data });
  }

  private attachRemoteStream(peerId: string, stream: MediaStream): void {
    let el = this.audioEls.get(peerId);
    if (!el) {
      el = new Audio();
      el.autoplay = true;
      this.audioEls.set(peerId, el);
    }
    el.srcObject = stream;
    el.muted = this.state.channel.speakerId === this.state.self?.id;
    void el.play().catch(() => {
      // L'autoplay è sbloccato dal gesto ENTRA; eventuali rifiuti
      // si risolvono alla prima interazione successiva.
    });
  }

  private closePeer(peerId: string): void {
    this.pcs.get(peerId)?.close();
    this.pcs.delete(peerId);
    this.pendingIce.delete(peerId);
    const el = this.audioEls.get(peerId);
    if (el) {
      el.srcObject = null;
      this.audioEls.delete(peerId);
    }
  }

  private stopLocalStream(): void {
    for (const track of this.localStream?.getTracks() ?? []) {
      track.stop();
    }
    this.localStream = null;
  }
}
