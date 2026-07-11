import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  TRANSLATION_TIMINGS,
  type ClientMessage,
  type TranslationTiming,
} from "../../shared/protocol.ts";
import { RoomManager } from "./rooms.ts";
import { createStaticHandler } from "./static.ts";
import { providerFromEnv } from "./translation/openaiRealtime.ts";

const PORT = Number(process.env.PORT ?? 8787);
const MAX_NICKNAME_LENGTH = 40;
const MAX_ROOM_LENGTH = 64;
// Heartbeat: i client spariti senza FIN (rete mobile, telefono bloccato)
// vengono terminati, liberando presenza ed eventuale lock PTT.
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Valida una tempistica arbitraria; "release" resta un alias di "consecutive". */
function parseTiming(value: string | undefined): TranslationTiming {
  if (value === "release") return "consecutive";
  return (TRANSLATION_TIMINGS as readonly string[]).includes(value ?? "")
    ? (value as TranslationTiming)
    : "streaming";
}

const translationProvider = providerFromEnv();
const defaultTiming = parseTiming(process.env.TRANSLATION_TIMING);
const rooms = new RoomManager(translationProvider, defaultTiming);

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
  if (req.url === "/metrics") {
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(rooms.metricsSnapshot()));
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

  socket.on("message", (raw: Buffer, isBinary: boolean) => {
    // Frame binario = chunk audio PCM16 del parlante (nessun wrapper JSON).
    if (isBinary) {
      const room = session.roomId ? rooms.get(session.roomId) : null;
      room?.handleAudio(session.peerId, raw);
      return;
    }
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
    // Il socket fa da guardia: se il peer si è già riconnesso (resumeKey),
    // la chiusura del vecchio socket non deve buttarlo fuori dalla stanza.
    if (session.roomId) rooms.leave(session.roomId, session.peerId, socket);
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
      const mode = message.mode === "event" ? "event" : "conversation";
      const role = message.role === "audience" ? "audience" : "speaker";
      const resumeKey =
        typeof message.resumeKey === "string" && message.resumeKey
          ? message.resumeKey.slice(0, 64)
          : undefined;
      session.roomId = roomId;
      // Una riconnessione con resumeKey riprende il peer esistente: da qui in
      // poi questa connessione agisce con l'id ripreso.
      session.peerId = rooms.get(roomId).join(
        {
          id: session.peerId,
          nickname,
          lang: String(message.lang).slice(0, 12),
          role,
          joinedAt: Date.now(),
        },
        socket,
        mode,
        resumeKey,
      );
      break;
    }
    case "update-lang": {
      const room = session.roomId ? rooms.get(session.roomId) : null;
      if (!room) return;
      room.updateLang(session.peerId, String(message.lang).slice(0, 12));
      break;
    }
    case "set-timing": {
      const room = session.roomId ? rooms.get(session.roomId) : null;
      if (!room) return;
      room.setTiming(parseTiming(message.timing));
      break;
    }
    case "solo-config": {
      const room = session.roomId ? rooms.get(session.roomId) : null;
      if (!room) return;
      room.setSolo(
        session.peerId,
        String(message.source).slice(0, 12),
        String(message.target).slice(0, 12),
      );
      break;
    }
    case "ptt": {
      const room = session.roomId ? rooms.get(session.roomId) : null;
      if (!room) return;
      if (message.action === "request") room.requestLock(session.peerId);
      else if (message.action === "cancel") room.cancelLock(session.peerId);
      else room.releaseLock(session.peerId);
      break;
    }
    case "stop-translation": {
      const room = session.roomId ? rooms.get(session.roomId) : null;
      if (!room) return;
      room.stopTranslation(session.peerId);
      break;
    }
    case "raise-hand": {
      const room = session.roomId ? rooms.get(session.roomId) : null;
      if (!room) return;
      room.raiseHand(session.peerId, Boolean(message.raised));
      break;
    }
    case "grant-floor": {
      const room = session.roomId ? rooms.get(session.roomId) : null;
      if (!room) return;
      room.grantFloor(session.peerId, String(message.peerId));
      break;
    }
    case "revoke-floor": {
      const room = session.roomId ? rooms.get(session.roomId) : null;
      if (!room) return;
      room.revokeFloor(session.peerId);
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
  console.log(`[babyl] server in ascolto su :${PORT} (ws path /ws)`);
  console.log(
    translationProvider
      ? `[babyl] traduzione attiva: ${translationProvider.name} (tempistica di default: ${defaultTiming})`
      : "[babyl] traduzione DISATTIVATA (OPENAI_API_KEY assente): voce originale a tutti",
  );
});
