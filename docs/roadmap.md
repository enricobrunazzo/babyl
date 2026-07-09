# Roadmap / backlog

Opzioni future per babyl, in stile TODO. Ogni voce indica **cosa**, **perché**,
la **complessità** stimata e **dove tocca** il codice. Nessuna è iniziata: sono
scelte aperte, da prendere quando servono.

L'MVP attuale copre già: onboarding invisibile, PTT half-duplex con lock
autoritativo, traduzione S2S (OpenAI Realtime), preset di tempistica
(streaming / interview / consecutive), metriche `/metrics` + pannello
`?debug=1`, modalità single-device, condivisione stanza (QR/link/Web Share) e
trasporto audio a frame binari.

## Ottimizzazioni banda / qualità

- [ ] **Compressione Opus sull'uplink client→server** — porta l'audio da
  ~384 kbit/s (PCM16 binario) a ~24–32 kbit/s (×~12–16), enorme su rete
  mobile/fiera. Encoder `WebCodecs AudioEncoder` nel browser, decoder
  nativo/wasm lato Node (→ PCM prima di OpenAI, che vuole PCM). **Complessità:
  alta** (dipendenza nativa/wasm, va collaudata con audio reale end-to-end).
  Tocca: `web/src/lib/pcm.ts`, `roomClient.ts`, `server/src/rooms.ts`,
  `server/src/index.ts`.
- [ ] **Jitter buffer adattivo lato client** — oggi è fisso a 50 ms; su reti
  instabili conviene adattarlo alla varianza di arrivo dei frame.
  **Complessità: media.** Tocca: `roomClient.ts` (`enqueuePlayback`).

## Traduzione / qualità

- [ ] **Rilevamento automatico della lingua nel single-device** — oggi il lato
  attivo si sceglie col toggle ⇄ (deterministico). Auto-detect via OpenAI
  Realtime, con fallback al toggle sulle frasi brevi (dove sbaglia).
  **Complessità: media.** Tocca: `openaiRealtime.ts`, `rooms.ts`, UI solo.
- [ ] **Reset periodico del contesto delle sessioni OpenAI** — le sessioni
  riusano il contesto per coerenza, ma nelle stanze lunghe il contesto cresce
  e viene rifatturato come input a ogni risposta. Serve una politica di reset
  (per durata/numero di enunciati). **Complessità: media.** Tocca:
  `rooms.ts` (`sessionFor`/`soloSessionFor`), `openaiRealtime.ts`.
- [ ] **VAD per tagliare i silenzi prima dell'invio** — meno secondi di
  inferenza fatturati. **Complessità: media.** Tocca: `roomClient.ts` (cattura),
  eventualmente il worklet.
- [ ] **Scelta della voce per utente** — oggi `OPENAI_REALTIME_VOICE` è globale.
  **Complessità: bassa.** Tocca: protocollo, `rooms.ts`, `openaiRealtime.ts`, UI.
- [ ] **Più lingue** — ampliare `LANGUAGES`. **Complessità: bassa.** Tocca:
  `web/src/lib/languages.ts`.

## Nuovi canali / trasporti

- [ ] **Integrazione con telefonate reali (PSTN)** — vedi
  [nota dedicata](#nota-integrazione-in-una-telefonata-normale). Bridge via
  provider di telefonia (Twilio/Telnyx) verso l'interfaccia `TranslationProvider`
  esistente. **Complessità: alta** (account telefonia, trasporto SIP/media-stream,
  resampling 8 kHz↔24 kHz, gestione full-duplex, aspetti legali sul consenso).
- [ ] **Modalità chiamata 1:1 in-app (WebRTC)** — UX da "chiamata" (squillo,
  1:1) sopra il modello stanza attuale. Resta app-to-app, non è una telefonata
  normale. **Complessità: media/alta.**

## Piattaforma / prodotto

- [ ] **Account e prepagato** — auth + database, Stripe, metering dei secondi di
  inferenza per stanza/sessione. Il punto di misura esiste già:
  `TranslationProvider` + `/metrics`. **Complessità: alta.**
- [ ] **Controllo accessi stanza (`roomKey` opzionale)** — chiave nel `join` per
  stanze private. **Complessità: bassa.** Tocca: protocollo, `index.ts`, `rooms.ts`, UI.
- [ ] **Scala su host cloud** — spostare il container quando il NAS non basta;
  il codice non cambia. Eventuale sharding delle stanze su più istanze.
  **Complessità: media** (stato stanza oggi in-memory per-processo).

---

## Nota: integrazione in una telefonata "normale"

Domanda ricorrente: *si può usare babyl dentro una normale telefonata?*
La risposta dipende da cosa si intende per "telefonata normale" — sono due casi
molto diversi.

### A. Numeri telefonici reali (PSTN/cellulare) — **fattibile oggi**

Con un provider di telefonia programmabile (**Twilio, Telnyx, Vonage…**) si
ottiene un numero e si **fa da ponte** sull'audio della chiamata:

- L'audio della chiamata arriva al server come **media stream** (Twilio Media
  Streams su WebSocket, oppure SIP/RTP): si alimenta **la stessa interfaccia
  `TranslationProvider`** che babyl usa già.
- Due schemi tipici:
  1. **Bridge a tre**: babyl è il terzo partecipante in mezzo a due telefoni e
     traduce in entrambe le direzioni;
  2. **Overlay a una gamba**: una persona è sull'app, l'altra su un telefono
     normale; babyl chiama il numero PSTN e inserisce l'audio tradotto.

**Vincoli reali da mettere in conto:**
- **Qualità audio**: la telefonia è **8 kHz μ-law narrowband**, molto sotto i
  24 kHz attuali → serve resampling 8↔24 kHz e la resa vocale è più povera.
- **Full-duplex**: una vera telefonata non è push-to-talk. Si perde la
  semplicità dell'half-duplex; servono gestione dei turni/eco e VAD robusto
  (i preset `streaming`/`consecutive` sono un punto di partenza).
- **Latenza**: la PSTN aggiunge ~200–400 ms sopra la pipeline attuale.
- **Costi**: al costo OpenAI si somma quello per-minuto del provider telefonia.
- **Legale**: registrare/elaborare l'audio di una chiamata richiede consenso
  esplicito di entrambe le parti (varia per giurisdizione).

**Nota architetturale**: il grosso si riusa. `TranslationProvider` è già
agnostico rispetto al trasporto: la telefonia sarebbe un **nuovo trasporto**
accanto al WebSocket, non un motore nuovo.

### B. Iniettarsi in una chiamata esistente (app Telefono, WhatsApp, FaceTime) — **non fattibile da terzi**

Non è possibile per un'app di terze parti inserirsi nel percorso audio della
telefonata nativa di qualcun altro senza **essere il dialer** o avere
integrazione **OS/operatore**. La traduzione live "dentro" la chiamata nativa è
oggi dominio delle funzioni di sistema (es. traduzione chiamate su iOS/Pixel):
richiederebbe un'app dialer nativa dedicata, fuori dallo scope web-first.

**In sintesi**: la strada praticabile e coerente con l'architettura è **A**
(bridge PSTN via provider di telefonia verso `TranslationProvider`); **B** non è
accessibile a un'app web di terze parti.
