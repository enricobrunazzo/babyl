import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Il client parla sempre con lo stesso host: in dev Vite fa da proxy verso il
// signaling server locale, in produzione ci pensa il reverse proxy.
// SIGNALING_PROXY_TARGET permette ai test E2E di usare una porta dedicata.
// - /ws  : WebSocket del pubblico (segnalazione, audio)
// - /api : API eventi programmati, così anche /organizer funziona in dev
const proxy = {
  "/ws": {
    target: process.env.SIGNALING_PROXY_TARGET ?? "ws://localhost:8787",
    ws: true,
  },
  "/api": {
    target:
      process.env.SIGNALING_PROXY_TARGET?.replace(/^ws/, "http") ??
      "http://localhost:8787",
  },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
});
