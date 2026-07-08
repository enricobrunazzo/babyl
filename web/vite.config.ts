import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Il client parla sempre con /ws sullo stesso host: in dev Vite fa da proxy
// verso il signaling server locale, in produzione ci pensa il reverse proxy.
// SIGNALING_PROXY_TARGET permette ai test E2E di usare una porta dedicata.
const wsProxy = {
  "/ws": {
    target: process.env.SIGNALING_PROXY_TARGET ?? "ws://localhost:8787",
    ws: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy: wsProxy },
  preview: { proxy: wsProxy },
});
