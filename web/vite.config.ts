import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Il client parla sempre con /ws sullo stesso host: in dev Vite fa da proxy
// verso il signaling server locale, in produzione ci pensa il reverse proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/ws": {
        target: "ws://localhost:8787",
        ws: true,
      },
    },
  },
});
