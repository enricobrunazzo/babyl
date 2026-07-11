# Changelog

Tutte le modifiche degne di nota a **babyl** sono annotate qui.

Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/) e il
progetto adotta il [Versionamento Semantico](https://semver.org/lang/it/).

## [Non rilasciato]

### Aggiunto

- **Correzioni UX dal collaudo.** Quattro rifiniture d'uso quotidiano:
  - **Feedback quando il PTT è negato**: alla risposta `ptt-denied` del server
    il telefono vibra brevemente e compare un avviso transitorio — «canale
    occupato» oppure, per il pubblico di un evento senza parola concessa,
    l'invito ad alzare la mano. Prima la pressione cadeva nel silenzio.
    (`web/src/lib/roomClient.ts`, `web/src/components/Room.tsx`)
  - **Ripresa immediata al ritorno in primo piano**: su mobile il socket muore
    spesso senza evento `close` mentre lo schermo è bloccato o si cambia app.
    Ora `visibilitychange`/`online` riattivano i context audio sospesi e, se il
    socket è morto, riconnettono subito azzerando il backoff (il rientro è un
    gesto dell'utente). Rianima anche le sessioni date per perse dopo i
    tentativi esauriti. (`web/src/lib/roomClient.ts`)
  - **Indicatore «Traduzione in riproduzione…»**: in simultanea la voce
    tradotta continua a uscire dopo che il canale è tornato libero; un avviso
    (nelle 14 lingue) lo segnala, così non si parla sopra la coda.
    (`web/src/lib/i18n.ts`, `web/src/components/Room.tsx`)
  - **Ripristino del form dopo un refresh**: nome e lingue dell'onboarding
    sopravvivono a un ricaricamento accidentale via `sessionStorage`
    (per-scheda, sparisce alla chiusura — come il banner PWA, niente
    localStorage: il sistema resta stateless). Il consenso si richiede ogni
    volta. (`web/src/components/Onboarding.tsx`)

- **Annullamento e interruzione della traduzione (risparmio di token).** Due
  controlli richiesti dal collaudo sul campo, utili soprattutto in
  single-device:
  - **Annulla l'enunciato**: mentre si tiene premuto il microfono (o il PTT in
    tempistica *consecutiva*) si può **scorrere via** — o premere `Esc` su
    desktop — per **scartare l'audio senza tradurlo**. Serve a rifare un
    enunciato sporcato (es. l'interlocutore parla sopra) senza spendere token:
    in consecutiva la traduzione parte solo al rilascio, quindi l'annullamento
    svuota il buffer d'ingresso prima che parta qualsiasi generazione.
  - **Interrompi la traduzione**: quando l'audio tradotto è in riproduzione,
    un pulsante **⏹ Interrompi** la ferma subito. In single-device annulla
    anche la generazione lato motore (`response.cancel`), così non si producono
    (e pagano) i token dell'audio residuo che non serve ascoltare; in stanza
    ferma solo la propria riproduzione, senza toccare la sessione condivisa
    degli altri ascoltatori. Localizzato in tutte le 14 lingue. Coperto da test
    unitari del server (annullamento senza commit, interruzione limitata alle
    sessioni single-device del richiedente) e da uno smoke UI del gesto
    "scorri per annullare". (`shared/protocol.ts`, `server/src/rooms.ts`,
    `server/src/translation/{provider,openaiRealtime}.ts`,
    `web/src/lib/{roomClient,holdToTalk}.ts`,
    `web/src/components/{MicButton,PTTButton,Room}.tsx`)
- **Modalità evento (conferenza + Q&A) per fiere, convention e platee
  multilingue.** Un relatore parla dal microfono dell'app e tutti gli spettatori
  ascoltano nella propria lingua, tradotti in tempo reale; il pubblico entra dal
  QR/link (che porta `?event=1`) come **ascoltatore a microfono disabilitato**.
  Prima di entrare, un **gate degli auricolari** obbligatorio con invito animato
  chiede conferma di indossarli (i browser non possono rilevarli via hardware,
  quindi è un'autodichiarazione) — evita fischi e rientri in sala. Per il **Q&A**
  lo spettatore **alza la mano**, il relatore la vede in coda e **concede la
  parola**: al beneficiario una voce sintetizzata sul dispositivo (Web Speech,
  nella sua lingua) annuncia *«microfono abilitato»* e si attiva il microfono,
  così può intervenire nella propria lingua arrivando tradotto a tutti. Il
  relatore può **ritirare la parola** in qualsiasi momento. Il server resta
  l'unica autorità sul canale: il pubblico può trasmettere solo con la parola
  concessa. Riusa l'instradamento di traduzione esistente (nessuna nuova
  meccanica audio). Coperto da test unitari del server (alzata di mano,
  concessione/ritiro, permessi) e da smoke UI end-to-end nei due ruoli.
  (`shared/protocol.ts`, `server/src/rooms.ts`, `web/src/lib/roomClient.ts`,
  `web/src/components/{EarphoneGate,Onboarding,Room}.tsx`)
- **PWA installabile in schermata Home (Android e iOS).** Web app manifest,
  service worker (installabilità + shell offline) e icone (192/512 + maskable)
  generate dal logo. L'app resta "zero download" ma ora può essere aggiunta alla
  Home e si apre a tutto schermo come un'app nativa. Un banner localizzato
  invita all'installazione: su Android/desktop Chromium usa il pulsante nativo
  (`beforeinstallprompt`), su iOS/Safari — che non espone l'evento — mostra le
  istruzioni manuali (Condividi → Aggiungi a Home). La chiusura è ricordata solo
  in `sessionStorage`, coerente con l'impianto stateless (nessun localStorage).
  Coperto da un test end-to-end dedicato (`tests/pwa.mjs`, in CI): manifest,
  icone, meta iOS, registrazione del service worker e banner su entrambi i
  percorsi (Android/desktop e iOS/Safari).

### Modificato

- **Microcopy dell'onboarding e del gate auricolari.** L'opzione di modalità
  passa da *«In stanza»* a *«Stanza»* (coerente con le sorelle *«Un solo
  dispositivo»* / *«Evento»*). Il gate di ingresso all'evento ora invita a
  indossare *«cuffie o auricolari»* (in tutte le lingue): l'animazione mostra
  un'icona di cuffie, quindi il testo copre entrambi i tipi di dispositivo
  invece dei soli auricolari. (`web/src/lib/i18n.ts`)

### Corretto

- **Instradamento dell'audio tradotto nelle stanze a 3+ interlocutori.** Le
  callback delle sessioni di traduzione consegnavano la voce (e i sottotitoli)
  in base a chi teneva il canale nel momento in cui la coda tradotta rientrava
  dal motore — asincrona e in ritardo — invece che a chi aveva pronunciato
  l'enunciato. Se un altro partecipante prendeva il PTT prima dell'arrivo della
  coda, la traduzione veniva instradata escludendo proprio quell'ascoltatore
  (audio mancante) e i sottotitoli finivano attribuiti al parlante sbagliato.
  Ora ogni sessione ricorda il parlante del proprio enunciato, fissato al
  momento dell'invio dell'audio, così la traduzione raggiunge sempre gli
  ascoltatori giusti anche se nel frattempo il canale passa di mano. Con solo
  due partecipanti il problema non si manifestava. (`server/src/rooms.ts`)

### Documentazione

- README: documentato l'instradamento per parlante come garanzia di
  comportamento nelle stanze multi-interlocutore.

## [0.1.0] — MVP

Prima base funzionante: piattaforma web-first per la traduzione simultanea
speech-to-speech, half-duplex e server-centrica.

### Aggiunto

- **Onboarding invisibile**: lingua auto-compilata da `navigator.language`,
  nickname a singolo tap, sistema stateless (nessun account, nessun
  localStorage), dark mode assoluta.
- **Interfaccia localizzata** in 14 lingue con fallback all'inglese e direzione
  RTL per l'arabo.
- **Push-to-Talk half-duplex** con lock del canale autoritativo lato server:
  richieste concorrenti serializzate, nessuna sovrapposizione di tracce.
- **Traduzione simultanea S2S** via OpenAI Realtime API, con instradamento
  server-centrico (voce originale a chi condivide la lingua, tradotta alle
  altre) e sottotitoli live per ascoltatore.
- **Preset di tempistica** selezionabili in stanza: `streaming` (simultanea),
  `interview` (frasi intere), `consecutive` (al rilascio del PTT).
- **Modalità single-device** (un telefono, due persone) additiva rispetto alla
  modalità stanza.
- **Condivisione stanza** via QR, copia link e Web Share.
- **Trasporto audio a frame binari** (PCM16 24 kHz), senza l'overhead base64 sul
  hop client↔server.
- **Resilienza**: riconnessione client con backoff esponenziale, heartbeat
  WebSocket lato server, retry a backoff sull'apertura delle sessioni di
  traduzione con avviso non fatale al fallimento.
- **Diagnostica**: endpoint `GET /metrics` (consumi e stima di costo) e pannello
  `?debug=1` lato client (banda, latenza, jitter buffer).

[Non rilasciato]: https://github.com/enricobrunazzo/babyl/compare/main...HEAD
