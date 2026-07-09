# babyl vs Google Translate

A prima vista babyl e la modalità conversazione/interprete di Google Translate
si somigliano: due (o più) persone, lingue diverse, traduzione vocale in tempo
reale. La differenza vera non è nel "tradurre", ma nel **modello d'uso**.

## Confronto sintetico

| Dimensione | **babyl** | **Google Translate** |
| --- | --- | --- |
| **Accesso** | Web, zero install, zero account: **il link è la stanza** | App da installare (o funzione di sistema su alcuni telefoni) |
| **Topologia** | **Multi-dispositivo, multi-persona**: N persone entrano via link, **ognuno ascolta nella propria lingua** | Pensato **1 telefono / 2 persone** (o 1:1); la stanza condivisa non c'è |
| **Motore** | **Speech-to-speech nativo** (OpenAI Realtime): preserva tono e intento | Prevalentemente **a cascata** (ASR → traduzione → sintesi), più orientato al testo |
| **Tempistica** | **Simultanea** ("effetto interprete TV") + preset intervista / consecutiva | Sostanzialmente **a turni** (parli → traduce) |
| **Turni** | **Half-duplex con lock autoritativo** sul server: niente sovrapposizioni | Nessuna gestione dei turni multi-utente |
| **Controllo** | **Self-hosted**, propria API key, **si paga al secondo**, dati sotto controllo | Servizio cloud gratuito: l'audio va a Google |

## Dove babyl si differenzia davvero

- **Stanza condivisa per link**: 5 persone, 5 lingue, ognuno ascolta la sua —
  è il vero punto. babyl serve gli **spazi condivisi** (meeting B2B, fiere,
  eventi multiculturali), non il singolo utente con una persona sola.
- **Simultaneità reale** e qualità speech-to-speech nativa.
- **Zero attrito**: nessun download, nessun account — l'onboarding è invisibile.
- **Sovranità del dato**: gira sul proprio NAS/container, con la propria chiave.
- Copre **anche** il caso d'uso di Google con la modalità single-device (un
  telefono, due persone), quindi non rinuncia a quello scenario.

## Dove Google è oggettivamente più forte

- **Lingue**: Google supera le 100; babyl oggi ne espone 14 in UI ed è limitato
  dalle lingue del modello realtime.
- **Gratis e offline**: Google funziona anche **offline** con i pacchetti
  scaricati ed è a costo zero. babyl richiede rete, inferenza cloud
  (~$0,30/min per lingua), una chiave e un server.
- **Ampiezza**: Google fa anche testo, fotocamera, documenti; babyl è **solo
  voce in tempo reale**, per scelta.
- **Maturità**: è un prodotto consumer maturo e rifinito.

## In una frase

Google Translate è un **traduttore generalista, individuale/1:1, gratuito e
app-based**. babyl è un **interprete simultaneo web-first per spazi condivisi**:
molte persone, molte lingue, tutti nella stessa stanza via link, in tempo reale,
self-hostabile. Non compete sul "tradurre una frase al volo da soli" — compete
sul *far parlare una sala multilingue senza che nessuno installi nulla*.
