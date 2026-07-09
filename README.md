# babyl

**Piattaforma Web-First per la Traduzione Simultanea Speech-to-Speech (S2S) ad Alte Prestazioni.**

Zero download, zero registrazione: il link è la stanza. Onboarding invisibile, audio WebRTC in tempo reale e interazione **Push-to-Talk Half-Duplex** per contesti ad alto valore (meeting B2B, fiere internazionali, eventi multiculturali).

## Avvio rapido

```bash
npm install
npm run dev
```

- Web app: http://localhost:5173 (il proxy Vite instrada `/ws` verso il signaling server)
- Signaling server: ws://localhost:8787/ws (health check: `GET /healthz`)

Apri la stessa stanza da due schede/dispositivi per provare il canale half-duplex: `http://localhost:5173/?room=demo` (oppure `/r/<nome-stanza>`; senza parametri si entra in `piazza`).

## Struttura del monorepo

```
babyl/
├── shared/protocol.ts        # Protocollo di segnalazione condiviso client/server
├── server/                   # Signaling server Node (ws)
│   └── src/
│       ├── index.ts          # WebSocket endpoint /ws + health check
│       ├── rooms.ts          # Stanze, presenza, lock PTT autoritativo
│       └── translation/
│           └── pipeline.ts   # Interfaccia provider S2S (punto di estensione)
└── web/                      # SPA mobile-first (Vite + React + TypeScript)
    └── src/
        ├── components/       # Onboarding, Room, PTTButton
        ├── hooks/useRoom.ts  # Stato stanza reattivo (useSyncExternalStore)
        └── lib/
            ├── roomClient.ts # WebSocket + mesh WebRTC + logica half-duplex
            └── languages.ts  # Rilevamento lingua da navigator.language
```

## Cosa implementa l'MVP (rif. documento di architettura)

**§2.1 — Onboarding invisibile**
- Lingua auto-compilata da `navigator.language` (es. `it-IT` → Italiano), menu a tendina minimale per l'override manuale.
- Nickname a singolo tap con `autocomplete="given-name"`.
- Sistema rigorosamente **stateless**: nessun dato in localStorage, nessun account.
- Un unico pulsante **ENTRA** con disclaimer legale e checkbox di validazione dell'età (16+ o consenso dei genitori).
- **Dark Mode assoluta** (sfondo `#000000`) per display OLED/AMOLED.

**§2.2 — Paradigma Push-to-Talk e gestione degli stati**
- **Stato Libero (verde)**: canale disponibile, tieni premuto per trasmettere (touch o barra spaziatrice su desktop).
- **Stato In Trasmissione (rosso)**: microfono locale aperto; gli stream in ricezione sono silenziati per prevenire loop acustici.
- **Stato Bloccato (grigio)**: *«Marco» sta parlando…* — il pulsante è disabilitato via software.
- Il **server è l'unica autorità sul lock del canale**: le richieste concorrenti vengono serializzate, impedendo collisione di pacchetti audio e sovrapposizione delle tracce.

**Trasporto audio**
- WebRTC mesh peer-to-peer con trickle ICE; la segnalazione passa dal server via WebSocket.
- La traccia microfono è sempre negoziata ma abilitata solo quando il server concede il lock PTT (nessuna rinegoziazione SDP alla pressione: latenza di attacco minima).

**Resilienza**
- Riconnessione automatica del client con backoff esponenziale (rete mobile instabile): la mesh viene ricostruita al rientro in stanza.
- Heartbeat WebSocket lato server: i client spariti senza chiudere la connessione (telefono bloccato, cambio rete) vengono terminati, liberando presenza ed eventuale lock PTT.
- ICE server configurabili via `VITE_ICE_SERVERS` (JSON) per aggiungere TURN in produzione.

## Roadmap verso la traduzione S2S

L'MVP consegna l'audio originale peer-to-peer. La traduzione simultanea (latenza end-to-end < 1.5 s) si innesta in `server/src/translation/pipeline.ts`, che definisce l'interfaccia `TranslationProvider`:

1. **SFU / media server** — instradare l'audio del parlante attraverso il server (es. mediasoup, LiveKit) invece della mesh P2P.
2. **Pipeline streaming** — `audio → VAD → STT streaming → traduzione → TTS streaming`, una uscita per ciascuna lingua presente nella stanza; in alternativa un provider S2S nativo voice-to-voice.
3. **Sottotitoli live** — l'interfaccia espone già `onTranscript` per i parziali.
4. **TURN server** — necessario in produzione per NAT restrittivi (l'MVP usa solo STUN).
5. **Business model prepagato** — metering dei secondi di inferenza per stanza/sessione, ancorato all'effettiva computazione AI.

## Test

- **Unitari** (`npm run test:unit`): logica di stanza e lock half-duplex del server (node:test).
- **End-to-end** (`npm run build && npm run test:e2e`): due browser reali entrano nella stessa stanza e si verificano roster, lock PTT esclusivo, inversione ruoli, riconnessione automatica dopo un riavvio del server e uscita peer. Richiede Chromium (Playwright); percorso personalizzabile via env `CHROMIUM_PATH`.

La CI (GitHub Actions) esegue typecheck, build e l'intera suite a ogni push su `main`.

## Deploy

Il container Docker è **all-in-one**: il server Node serve la SPA buildata e il WebSocket `/ws` sulla stessa porta (8787), quindi al reverse proxy basta un solo upstream. L'immagine è pubblicata su `ghcr.io/enricobrunazzo/babyl:latest` a ogni push su `main` (workflow Docker).

- **Self-hosted / Synology NAS**: guida passo-passo in [`docs/deploy-synology.md`](docs/deploy-synology.md) (Container Manager + reverse proxy DSM con supporto WebSocket + Let's Encrypt).
- **Qualsiasi host Docker**: `docker compose up -d` col [`docker-compose.yml`](docker-compose.yml) incluso.
- **Split frontend/backend** (alternativa): la SPA è comunque deployabile come statico (Vercel/Netlify, output `web/dist`) impostando `VITE_SIGNALING_URL` verso il signaling server; il server richiede un processo persistente (no serverless).

HTTPS è obbligatorio in produzione: senza secure context il browser nega l'accesso al microfono.

## Script

| Comando | Descrizione |
| --- | --- |
| `npm run dev` | Avvia server + web in parallelo |
| `npm run build` | Typecheck server + build produzione web |
| `npm run typecheck` | Typecheck di tutti i workspace |
| `npm run test:unit` | Test unitari del server |
| `npm run test:e2e` | Test end-to-end con due browser (richiede build) |
