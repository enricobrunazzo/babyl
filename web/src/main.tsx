import React from "react";
import ReactDOM from "react-dom/client";
// Inter (variabile, self-hosted): tipografia UI pulita e professionale,
// impacchettata nel bundle → nessuna richiesta esterna, coerente con la PWA
// offline e col vincolo "zero download". Copre latino/cirillico/greco; per
// CJK, arabo e devanagari si ricade sul font di sistema (Inter non li include).
import "@fontsource-variable/inter/wght.css";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// PWA: registra il service worker (installabilità + shell offline). Solo in
// produzione, così in sviluppo l'HMR di Vite non viene intercettato dalla cache.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
