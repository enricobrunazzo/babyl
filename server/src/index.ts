import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage } from "../../shared/protocol.ts";
import { RoomManager } from "./rooms.ts";
import { createStaticHandler } from "./static.ts";

const PORT = Number(process.env.PORT ?? 8787);
const MAX_NICKNAME_LENGTH = 40;
const MAX_ROOM_LENGTH = 64;
// Heartbeat: i client spariti senza FIN (rete mobile, telefono bloccato)
// vengono terminati, liberando presenza ed eventuale lock PTT.
const HEARTBEAT_INTERVAL_MS = 30_000;

const rooms = new RoomManager();

const staticHandler = createStaticHandler(
  process.env.STATIC_DIR ??
    fileURLToPath(new URL("../../web/dist", import.meta.url)),
);

const httpServer = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (staticHandler) {
    staticHandler(req, res);
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

interface Session {
  peerId: string;
  roomId: string | null;
}

wss.on("connection", (socket: WebSocket) => {
  const session: Session = { peerId: randomUUID(), roomId: null };

  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, HEARTBEAT_INTERVAL_MS);

  socket.on("message", (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "invalid-json" }));
      return;
    }
    handleMessage(socket, session, message);
  });

  socket.on("close", () => {
    clearInterval(heartbeat);
    if (session.roomId) rooms.leave(session.roomId, session.peerId);
  });
});

function handleMessage(
  socket: WebSocket,
  session: Session,
  message: ClientMessage,
): void {
  switch (message.type) {
    case "join": {
      if (session.roomId) return; // già in una stanza
      const roomId = String(message.room).slice(0, MAX_ROOM_LENGTH).trim();
      const nickname = String(message.nickname)
        .slice(0, MAX_NICKNAME_LENGTH)
        .trim();
      if (!roomId || !nickname) {
        socket.send(
          JSON.stringify({ type: "error", message: "invalid-join" }),
        );
        return;
      }
      session.roomId = roomId;
      rooms.get(roomId).join(
        {
          id: session.peerId,
          nickname,
          lang: String(message.lang).slice(0, 12),
          joinedAt: Date.now(),
        },
        socket,
      );
      break;
    }
    case "ptt": {
      const room = session.roomId ? rooms.get(session.roomId) : null;
      if (!room) return;
      if (message.action === "request") room.requestLock(session.peerId);
      else room.releaseLock(session.peerId);
      break;
    }
    case "signal": {
      const room = session.roomId ? rooms.get(session.roomId) : null;
      if (!room) return;
      room.relaySignal(session.peerId, message.to, message.data);
      break;
    }
    case "leave": {
      if (session.roomId) {
        rooms.leave(session.roomId, session.peerId);
        session.roomId = null;
      }
      break;
    }
  }
}

httpServer.listen(PORT, () => {
  console.log(`[babyl] signaling server in ascolto su :${PORT} (ws path /ws)`);
});
