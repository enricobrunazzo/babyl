import type { WebSocket } from "ws";
import type {
  ChannelState,
  PeerInfo,
  ServerMessage,
  SignalPayload,
} from "../../shared/protocol.ts";

interface Peer {
  info: PeerInfo;
  socket: WebSocket;
}

/**
 * Una stanza di traduzione. Il server è l'unica autorità sullo stato del
 * canale Half-Duplex: le richieste PTT concorrenti vengono serializzate qui,
 * quindi due utenti non possono mai trasmettere contemporaneamente.
 */
export class Room {
  readonly peers = new Map<string, Peer>();
  private speakerId: string | null = null;

  constructor(readonly id: string) {}

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
    });
  }

  leave(peerId: string): void {
    if (!this.peers.delete(peerId)) return;
    if (this.speakerId === peerId) {
      this.speakerId = null;
      this.broadcast({ type: "channel", channel: this.channel });
    }
    this.broadcast({ type: "peer-left", peerId });
  }

  /** Concede il lock solo se il canale è libero (o già del richiedente). */
  requestLock(peerId: string): void {
    if (this.speakerId !== null && this.speakerId !== peerId) {
      this.send(peerId, { type: "ptt-denied", reason: "busy" });
      return;
    }
    this.speakerId = peerId;
    this.broadcast({ type: "channel", channel: this.channel });
  }

  releaseLock(peerId: string): void {
    if (this.speakerId !== peerId) return;
    this.speakerId = null;
    this.broadcast({ type: "channel", channel: this.channel });
  }

  relaySignal(from: string, to: string, data: SignalPayload): void {
    this.send(to, { type: "signal", from, data });
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

  get(id: string): Room {
    let room = this.rooms.get(id);
    if (!room) {
      room = new Room(id);
      this.rooms.set(id, room);
    }
    return room;
  }

  /** Rimuove il peer e distrugge la stanza se vuota (sistema stateless). */
  leave(roomId: string, peerId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.leave(peerId);
    if (room.peers.size === 0) this.rooms.delete(roomId);
  }
}
