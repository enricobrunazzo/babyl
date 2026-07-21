# babyl

**Piattaforma Web-First per la Traduzione Simultanea Speech-to-Speech (S2S) ad Alte Prestazioni.**

Zero download, zero registrazione: il link è la stanza. Onboarding invisibile, audio WebRTC in tempo reale e interazione **Push-to-Talk Half-Duplex** per contesti ad alto valore (meeting B2B, fiere internazionali, eventi multiculturali).

In cosa si differenzia dai traduttori generalisti (es. Google Translate): [`docs/confronto.md`](docs/confronto.md).

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
├── shared/protocol.ts        # Protocollo segnalazione + audio, condiviso client/server
├── server/                   # Server Node (ws): stanze, lock PTT, snodo audio
│   └── src/
│       ├── index.ts          # WebSocket /ws + SPA statica + health check
│       ├── rooms.ts          # Presenza, lock autoritativo, instradamento audio
│       └── translation/
│           ├── provider.ts        # Interfaccia motore di traduzione S2S
│           └── openaiRealtime.ts  # Provider OpenAI Realtime (speech-to-speech)
└── web/                      # SPA mobile-first (Vite + React + TypeScript)
    ├── public/pcm-capture-worklet.js  # Cattura microfono (AudioWorklet)
    └── src/
        ├── components/       # Onboarding, Room, PTTButton, MicButton
        ├── hooks/useRoom.ts  # Stato stanza reattivo (useSyncExternalStore)
        └── lib/
            ├── holdToTalk.ts # Gesto push-to-talk con "scorri per annullare"
            ├── roomClient.ts # WebSocket, cattura/riproduzione PCM, half-duplex
            ├── pcm.ts        # Conversioni PCM16 ↔ ArrayBuffer (frame binari)
            ├── languages.ts  # Elenco lingue + rilevamento da navigator.language
            └── i18n.ts       # Stringhe UI localizzate (15 lingue, RTL per l'arabo)
```

## Cosa implementa l'MVP (rif. documento di architettura)

**§2.1 — Onboarding invisibile**
- Lingua auto-compilata da `navigator.language` (es. `it-IT` → Italiano), menu a tendina minimale per l'override manuale.
- **Interfaccia localizzata**: il testo dell'app segue la lingua scelta dal partecipante. Chi entra e sceglie *English* vede onboarding e stanza in inglese, chi sceglie *Deutsch* in tedesco, e così via per tutte le 15 lingue supportate (`web/src/lib/i18n.ts`, con fallback all'inglese). In stanza segue la lingua d'ascolto, quindi cambia a caldo anche dal selettore *Lingua di ascolto*; per l'arabo la direzione del testo passa automaticamente a **RTL**.
- Nickname a singolo tap con `autocomplete="given-name"`.
- Sistema rigorosamente **stateless**: nessun dato in localStorage, nessun account.
- Un unico pulsante **ENTRA** con disclaimer legale e checkbox di validazione dell'età (16+ o consenso dei genitori).
- **Dark Mode assoluta** (sfondo `#000000`) per display OLED/AMOLED.
- **Installabile come app (PWA)**: resta "zero download" — il link è la stanza — ma può essere aggiunta alla schermata Home e aprirsi a tutto schermo, con icona dedicata, su **Android e iOS**. Un banner localizzato la propone in installazione: su Android/desktop (Chromium) col pulsante nativo, su iOS/Safari con le istruzioni manuali (Condividi → *Aggiungi a Home*). Manifest + service worker in `web/public/`; la chiusura del banner è ricordata solo in `sessionStorage` (nessun localStorage, sistema stateless).

**§2.2 — Paradigma Push-to-Talk e gestione degli stati**
- **Stato Libero (verde)**: canale disponibile, tieni premuto per trasmettere (touch o barra spaziatrice su desktop).
- **Stato In Trasmissione (rosso)**: microfono locale aperto; gli stream in ricezione sono silenziati per prevenire loop acustici.
- **Stato Bloccato (grigio)**: *«Marco» sta parlando…* — il pulsante è disabilitato via software.
- Il **server è l'unica autorità sul lock del canale**: le richieste concorrenti vengono serializzate, impedendo collisione di pacchetti audio e sovrapposizione delle tracce.

**Traduzione simultanea (architettura server-centrica)**
- L'audio viaggia sempre attraverso il server (niente peer-to-peer, niente TURN): il paradigma half-duplex significa un solo flusso alla volta, che il server smista.
- Il parlante invia PCM16 mono 24 kHz via WebSocket (cattura AudioWorklet); gli ascoltatori della sua stessa lingua ricevono la voce originale, per ogni altra lingua in stanza il server apre una sessione col motore di traduzione e distribuisce l'audio tradotto.
- **Motore**: OpenAI Realtime API (speech-to-speech nativo). La tempistica è un'**impostazione di stanza** scelta dal selettore in UI e condivisa da tutti i partecipanti:
  - `streaming` (default) — **simultanea** (effetto interprete TV): il VAD server-side segmenta sulle pause naturali e la voce tradotta parte mentre il parlante prosegue;
  - `interview` — come streaming ma con pausa di segmentazione più lunga (≈900 ms): le pause retoriche non spezzano la frase, per **turni netti tipo intervista**;
  - `consecutive` — la traduzione parte solo al **rilascio del PTT** (turni puliti, latenza pari alla durata dell'enunciato).
  
  `TRANSLATION_TIMING` imposta il default delle nuove stanze (`release` resta un alias di `consecutive`). Al rilascio del PTT una coda di silenzio fa chiudere l'ultimo segmento nelle modalità a VAD. Sessioni riusate tra enunciati per mantenere il contesto.
- **Instradamento per parlante (stanze a 3+)**: l'audio tradotto rientra dal motore in ritardo rispetto alla voce. Il server lo consegna in base a **chi ha pronunciato l'enunciato** (attribuito **per segmento**, in ordine FIFO, al momento del commit di ciascun segmento), non a chi tiene il canale quando la coda arriva: così, anche se un altro partecipante prende il PTT nel frattempo, la traduzione (e i sottotitoli) raggiunge sempre gli ascoltatori giusti e resta attribuita al parlante corretto.
- **Sottotitoli live**: la trascrizione della traduzione arriva in streaming a ogni ascoltatore nella propria lingua.
- Senza `OPENAI_API_KEY` l'app funziona in modalità **voce originale** (nessuna traduzione, tutti sentono tutto): utile per sviluppo e test senza costi.
- Il motore è pluggabile: `server/src/translation/provider.ts` definisce l'interfaccia, `openaiRealtime.ts` è l'implementazione attiva.

**Modalità single-device (un telefono, due persone)**
- Scelta in onboarding accanto alla modalità stanza: si indicano **due lingue** (lato A e lato B) invece della sola lingua d'ascolto. La modalità stanza multi-dispositivo resta identica e invariata.
- Le due persone parlano **a turno** sullo stesso dispositivo: si tiene premuto il PTT, si parla nella lingua del lato attivo e — al rilascio — la traduzione esce **a voce alta dallo stesso telefono**. Il pulsante **⇄ Inverti i lati** scambia sorgente e destinazione per il turno successivo.
- **Riuso dell'architettura**: è una stanza privata di un solo peer; il server traduce sorgente→destinazione e rimanda l'audio al mittente. La tempistica è forzata a **consecutiva** (voce tradotta al rilascio, quando il microfono è già chiuso) così non si innesca il loop acustico mic↔altoparlante.
- **Annulla e interrompi (risparmio di token)**: mentre parli puoi **scorrere via** dal microfono (o premere `Esc` su desktop) per **scartare l'enunciato senza tradurlo** — utile se l'audio si sporca (l'interlocutore parla sopra) e vuoi rifarlo pulito. Poiché in consecutiva la traduzione parte solo al rilascio, l'annullamento svuota il buffer prima di ogni generazione: zero token spesi. Quando la voce tradotta è in riproduzione, il pulsante **⏹ Interrompi** la ferma subito e annulla anche la generazione lato motore (`response.cancel`), così non paghi i token dell'audio che non ti serve ascoltare.
- Il rilevamento automatico della lingua è un raffinamento successivo: oggi il lato attivo si sceglie col toggle (deterministico, nessun errore su frasi brevi).

**Modalità evento (conferenza + Q&A)**
- Pensata per **fiere, convention ed eventi pubblici** con platea che parla lingue diverse: un **relatore** parla dal microfono dell'app e **tutti ascoltano nella propria lingua**, tradotti in tempo reale.
- Si crea dall'onboarding scegliendo la scheda **Evento** (chi la crea è il relatore); il pubblico entra dal **QR/link** condiviso, che porta `?event=1`, come **ascoltatore col microfono disabilitato** (ascolto puro, nessun `getUserMedia` finché non serve).
- **Cuffie/auricolari obbligatori**: prima di entrare, un gate con invito animato (icona di cuffie) chiede conferma di indossare cuffie o auricolari. I browser non espongono un modo affidabile per rilevarli via hardware, quindi è un'**autodichiarazione** (conferma esplicita) — serve a evitare fischi e rientri quando l'audio tradotto potrebbe uscire dagli altoparlanti in sala.
- **Q&A con alzata di mano**: lo spettatore **alza la mano**, il relatore la vede nella coda *Richieste di intervento* e **concede la parola**. Al beneficiario una voce sintetizzata **sul dispositivo** (Web Speech, nella sua lingua — gratuita, offline) annuncia *«microfono abilitato»*, il microfono si attiva e può intervenire nella **propria lingua**, arrivando **tradotto a tutti**. Il relatore può **ritirare la parola** in ogni momento (chiudendo anche il canale se il pubblico sta parlando).
- **Il server resta l'unica autorità sul canale**: in modalità evento il pubblico ottiene il lock PTT **solo** se ha la parola concessa; altrimenti la richiesta è negata (`ptt-denied` con `reason: "not-granted"`). Riusa l'instradamento di traduzione esistente: nessuna nuova meccanica audio, solo ruoli e controllo del turno sopra il PTT half-duplex.

**Resilienza**
- Riconnessione automatica del client con backoff esponenziale (rete mobile instabile); al ritorno in primo piano (`visibilitychange`/`online`) i context audio sospesi riprendono e un socket morto in background viene riconnesso subito, senza attendere il backoff.
- **Continuità d'identità alla riconnessione**: il client presenta una chiave di ripresa segreta (`resumeKey`, per-sessione, mai ribroadcastata) e il server gli fa riprendere lo stesso peer — stesso id nel roster e, in modalità evento, mano alzata e parola concessa conservate — invece di creare un doppione accanto allo zombie.
- Heartbeat WebSocket lato server: i client spariti senza chiudere la connessione (telefono bloccato, cambio rete) vengono terminati, liberando presenza ed eventuale lock PTT.
- **Backpressure sull'audio in uscita**: verso gli ascoltatori con troppo arretrato sul socket (rete lenta) i frame vengono scartati — l'audio è live, in ritardo non servirebbe più — invece di far crescere la memoria del server.
- Le sessioni verso il motore inattive da oltre 5 minuti vengono chiuse (e ricreate in modo trasparente alla pressione PTT successiva): niente connessioni pendenti nelle stanze lunghe, né sorprese da sessione scaduta lato OpenAI; una chiusura inattesa del socket del motore viene comunque rilevata e la sessione rimpiazzata.
- Apertura della sessione di traduzione con **retry a backoff esponenziale** sui fallimenti transitori del motore (OpenAI sovraccarico → `503`, rate limit → `429`, errori di rete); fallisce subito sugli errori non ritentabili (`401/403/404`: chiave/permessi/modello). Se dopo i tentativi la traduzione resta non disponibile, il client mostra un avviso **non fatale** ("traduzione temporaneamente non disponibile") senza cadere dalla stanza.

## Configurazione del server

| Variabile | Default | Descrizione |
| --- | --- | --- |
| `PORT` | `8787` | Porta HTTP/WebSocket |
| `OPENAI_API_KEY` | — | Abilita la traduzione simultanea; assente = voce originale |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2.1-mini` | Modello Realtime da usare |
| `OPENAI_REALTIME_VOICE` | `marin` | Voce della sintesi |
| `OPENAI_VAD_THRESHOLD` | `0.6` | Sensibilità del VAD (0–1). Più alta = meno reattiva al rumore di fondo, così nelle pause non partono segmenti spuri che ripeterebbero l'ultimo enunciato. Alzala (es. `0.7`) in sale molto rumorose. |
| `TRANSLATION_TIMING` | `streaming` | Tempistica di default delle nuove stanze: `streaming` (simultanea), `interview` (frasi intere), `consecutive` (al rilascio del PTT; `release` è un alias). Modificabile in stanza dal selettore UI. |
| `STATIC_DIR` | `web/dist` | Cartella della SPA buildata |
| `BABYL_ADMIN_TOKEN` | — | Abilita l'API degli **eventi programmati** (`/api/events`, header `x-admin-token`) e l'**area organizzatore** su `/organizer` (crea eventi con link/QR stabile). Assente = spente, server identico a prima. Auth organizzatore per email in fase 2. |
| `BABYL_DB_PATH` | `data/babyl.db` | Percorso del file SQLite (persistenza eventi). In Docker va su volume montato. |

## Diagnostica e consumi

- **`GET /metrics`** (JSON): fotografia dei consumi lato server — byte audio in ingresso/uscita, millisecondi di canale PTT, millisecondi di audio inviati/ricevuti dal motore **per coppia di lingue**, più una stima di costo OpenAI Realtime (`estCostUsd`, basata su ~$0,06/min in ingresso e ~$0,24/min in uscita). I totali sono cumulati e sopravvivono alla chiusura delle stanze; `perRoom` mostra solo le stanze vive. È il punto di misura che alimenta il metering di roadmap.
- **`?debug=1`** in stanza: pannello diagnostico lato client con banda istantanea ↑/↓ (kbit/s), latenza inizio-parlante → primo frame audio, riserva del jitter buffer di riproduzione e totali trasferiti. Attivo solo con il parametro; a riposo non ha costo.

Ordini di grandezza utili: l'audio è PCM16 mono 24 kHz e viaggia come **frame WebSocket binari** (~384 kbit/s per flusso; niente più il ~33% di overhead base64 sul hop client↔server — la conversione base64 avviene solo al confine col motore di traduzione, che la richiede). L'egress del server cresce col numero di ascoltatori e delle lingue in stanza.

## Roadmap

Il backlog completo (con complessità e punti di intervento) è in
[`docs/roadmap.md`](docs/roadmap.md) — inclusa l'analisi
sull'**integrazione con le telefonate reali (PSTN)**. In sintesi:

1. **Fase pubblica**: account e prepagato (auth + database, Stripe, metering dei secondi di inferenza per stanza/sessione — il punto di misura è l'interfaccia `TranslationProvider`).
2. **Qualità**: compressione Opus sull'uplink, auto-detect lingua nel single-device, reset periodico del contesto OpenAI, VAD per tagliare i silenzi, scelta voce per utente, più lingue.
3. **Nuovi canali**: bridge verso le telefonate PSTN (Twilio/Telnyx) sopra `TranslationProvider`; chiamata 1:1 in-app (WebRTC).
4. **Scala**: spostare il container su un host cloud quando il NAS non basta; il codice non cambia.

## Test

- **Unitari** (`npm run test:unit`): lock half-duplex e instradamento audio/traduzione del server, con provider finto (node:test).
- **End-to-end** (`npm run build && npm run test:e2e`): due browser reali entrano nella stessa stanza e si verificano roster, lock PTT esclusivo, relay audio attraverso il server, inversione ruoli, riconnessione automatica dopo un riavvio del server e uscita peer. Richiede Chromium (Playwright); percorso personalizzabile via env `CHROMIUM_PATH`.
- Il collaudo della **traduzione reale** richiede una `OPENAI_API_KEY` e va fatto su un deploy (o in locale) con due dispositivi e lingue diverse.

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

## Changelog

Le modifiche degne di nota sono annotate in [`CHANGELOG.md`](CHANGELOG.md).
