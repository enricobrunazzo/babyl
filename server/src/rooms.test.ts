import test from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import type { PeerInfo, ServerMessage } from "../../shared/protocol.ts";
import { Room, RoomManager } from "./rooms.ts";

interface FakeSocket {
  sent: ServerMessage[];
  readyState: number;
  OPEN: number;
  send(payload: string): void;
}

function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    sent: [],
    readyState: 1,
    OPEN: 1,
    send(payload: string) {
      socket.sent.push(JSON.parse(payload) as ServerMessage);
    },
  };
  return socket;
}

function peer(id: string, nickname = id): PeerInfo {
  return { id, nickname, lang: "it", joinedAt: Date.now() };
}

function lastOfType<T extends ServerMessage["type"]>(
  socket: FakeSocket,
  type: T,
): Extract<ServerMessage, { type: T }> | undefined {
  return socket.sent
    .filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type)
    .at(-1);
}

test("join: welcome al nuovo peer, peer-joined agli altri", () => {
  const room = new Room("demo");
  const a = fakeSocket();
  const b = fakeSocket();

  room.join(peer("a", "Marco"), a as unknown as WebSocket);
  room.join(peer("b", "Anna"), b as unknown as WebSocket);

  const welcome = lastOfType(b, "welcome");
  assert.equal(welcome?.self.nickname, "Anna");
  assert.deepEqual(welcome?.peers.map((p) => p.id), ["a"]);
  assert.equal(welcome?.channel.speakerId, null);

  const joined = lastOfType(a, "peer-joined");
  assert.equal(joined?.peer.nickname, "Anna");
});

test("lock PTT: esclusivo, negato se occupato, rilasciato correttamente", () => {
  const room = new Room("demo");
  const a = fakeSocket();
  const b = fakeSocket();
  room.join(peer("a", "Marco"), a as unknown as WebSocket);
  room.join(peer("b", "Anna"), b as unknown as WebSocket);

  room.requestLock("a");
  assert.equal(room.channel.speakerId, "a");
  assert.equal(lastOfType(b, "channel")?.channel.speakerName, "Marco");

  // Richiesta concorrente: negata, lo speaker non cambia
  room.requestLock("b");
  assert.equal(room.channel.speakerId, "a");
  assert.equal(lastOfType(b, "ptt-denied")?.reason, "busy");

  // Il rilascio da parte di chi non detiene il lock è ignorato
  room.releaseLock("b");
  assert.equal(room.channel.speakerId, "a");

  room.releaseLock("a");
  assert.equal(room.channel.speakerId, null);

  // Ora il canale è libero per B
  room.requestLock("b");
  assert.equal(room.channel.speakerId, "b");
});

test("leave dello speaker: il canale torna libero per tutti", () => {
  const room = new Room("demo");
  const a = fakeSocket();
  const b = fakeSocket();
  room.join(peer("a"), a as unknown as WebSocket);
  room.join(peer("b"), b as unknown as WebSocket);

  room.requestLock("a");
  room.leave("a");

  assert.equal(room.channel.speakerId, null);
  assert.equal(lastOfType(b, "channel")?.channel.speakerId, null);
  assert.equal(lastOfType(b, "peer-left")?.peerId, "a");
});

test("relaySignal: consegna solo al destinatario", () => {
  const room = new Room("demo");
  const a = fakeSocket();
  const b = fakeSocket();
  const c = fakeSocket();
  room.join(peer("a"), a as unknown as WebSocket);
  room.join(peer("b"), b as unknown as WebSocket);
  room.join(peer("c"), c as unknown as WebSocket);

  room.relaySignal("a", "b", { kind: "offer", sdp: "sdp-test" });

  const signal = lastOfType(b, "signal");
  assert.equal(signal?.from, "a");
  assert.equal(lastOfType(c, "signal"), undefined);
  assert.equal(lastOfType(a, "signal"), undefined);
});

test("RoomManager: distrugge le stanze vuote (stateless)", () => {
  const manager = new RoomManager();
  const room = manager.get("effimera");
  room.join(peer("a"), fakeSocket() as unknown as WebSocket);

  manager.leave("effimera", "a");

  // La stanza restituita ora è una nuova istanza, senza peer residui
  assert.equal(manager.get("effimera").peers.size, 0);
  assert.notEqual(manager.get("effimera"), room);
});
