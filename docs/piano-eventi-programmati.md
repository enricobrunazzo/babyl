# Piano: eventi programmati + account organizzatore

Piano tecnico per creare eventi **in anticipo** (con link stabile) e introdurre
un **account per l'organizzatore**, senza rompere il principio «zero download,
zero registrazione» del pubblico. È il dettaglio implementativo della voce
_«Account e prepagato»_ della [roadmap](roadmap.md).

## Obiettivo

Oggi una stanza/evento esiste solo mentre qualcuno è connesso: lo stato è
**in memoria e per-processo** (`Room` in `server/src/rooms.ts`, con `Map` di peer
e sessioni), e il link è semplicemente il nome della stanza (`web/src/lib/roomName.ts`).
Non c'è modo di:

1. preparare un evento prima che inizi (data, ora, lingue attese, relatore);
2. dargli un link/QR stabile deciso in anticipo;
3. sapere **chi** l'ha creato (per fatturarlo);
4. far ritrovare all'organizzatore i suoi eventi.

## Principio guida: due livelli, una sola magia

| Ruolo | Identità | Perché |
| --- | --- | --- |
| **Pubblico / ascoltatori** | **Nessun login, mai** | È l'USP. QR → lingua → ascolto. Da non toccare. |
| **Organizzatore** | **Account leggero** (email magic-link o OAuth Google/Apple) | Serve solo a lui: programmare, ritrovare, essere fatturato. |

Regola: tutto ciò che aggiungiamo vive **attorno** al join anonimo esistente,
non dentro. Un partecipante che apre un link d'evento non deve accorgersi che
dietro c'è un account e un database.

## Stato attuale (punti d'aggancio già pronti)

- **Metering**: `TranslationProvider` + `GET /metrics` misurano già i ms per
  coppia di lingue e stimano il costo (`rooms.ts` → `estCostUsd`, $0,06/min in,
  $0,24/min out). È il punto di misura per il billing: **non serve riscriverlo**.
- **Continuità d'identità**: `resumeKey` per-sessione già gestita al join
  (riconnessione senza doppioni). Il modello «segreto presentato al join» è lo
  stesso schema che useremo per la chiave d'evento.
- **Modalità evento**: ruoli relatore/pubblico, mano alzata, concessione parola
  già esistono. Qui aggiungiamo solo **persistenza e proprietà**, non nuova
  meccanica audio.

## Architettura proposta

### 1. Persistenza (nuovo)

**Scelta: SQLite via `node:sqlite`** (modulo integrato in Node 22). Deciso per
la fase attuale — deploy self-hosted, **un solo container** sul NAS:

- **Zero dipendenze**: il server resta `ws` + `tsx`. Nessun modulo nativo da
  compilare su Alpine (musl), nessun cambio al Dockerfile.
- **Un file, non un servizio**: coerente col «un solo container», backup =
  snapshot Synology; il file DB va su **volume montato** (non nel layer immagine).
- **ACID + WAL**: transazioni per lo scalo dei crediti; verificato su Node 22.22.
- Caveat: `node:sqlite` è marcato *experimental* → emette un `ExperimentalWarning`
  (silenziabile con `--disable-warning=ExperimentalWarning` nello start) e l'API
  potrebbe cambiare tra major di Node. Mitigazione sotto.
- **Astrazione in `db.ts`**: tutte le query dietro un'interfaccia minima, così il
  passaggio a `better-sqlite3` (se l'experimental desse fastidio) o a
  **Postgres/Neon** (nella futura fase cloud **multi-istanza**, dove un file
  locale non basta più) è un cambio contenuto a un solo file, non un rifacimento.

Due tabelle minime:

```
organizer(id, email, created_at, credits_seconds?, stripe_customer_id?)
event(id, slug, organizer_id, title, listen_langs[], timing,
      scheduled_at, expires_at, host_resume_key_hash, status, created_at)
```

- `slug` = il nome-stanza stabile deciso in anticipo (il link è `?/<slug>` o
  `?event=<slug>`). Unico, generabile da `roomName.ts` o scelto dall'organizzatore.
- `host_resume_key_hash`: hash della chiave segreta che identifica **chi è il
  relatore** quando l'evento va live — così solo chi ha creato l'evento apre il
  canale come relatore, anche senza sessione WebSocket attiva prima.
- `status`: `scheduled | live | ended`.

La `Room` in memoria resta il runtime; il DB è la **fonte di verità a riposo**.
All'avvio di un join su uno slug esistente, il server **idrata** la `Room` dal
record `event` (lingue attese, timing, chi è relatore) invece di crearla vuota.

### 2. Auth organizzatore (nuovo, isolato)

- Endpoint separati `POST /auth/magic-link` + callback, oppure OAuth. Sessione
  organizzatore via cookie httpOnly. **Non tocca** il flusso WebSocket del
  pubblico.
- Nessun account per il pubblico: il join anonimo su `event` resta identico a oggi.

### 3. Creazione evento in anticipo (nuovo)

- Area organizzatore (web) → «Nuovo evento»: titolo, data/ora, lingue attese,
  timing (`streaming`/`interview`/`consecutive`), slug. Salva un record `event`
  con `status=scheduled` e restituisce **link + QR** subito condivisibili.
- Alla data, il relatore apre il proprio link (autenticato o con la sua
  `resumeKey` d'evento) → la `Room` passa a `live`.

### 4. Aggancio billing (estende l'esistente)

- A `event` che termina, si legge il consumo reale già calcolato in `/metrics`
  per quella stanza e si **decrementano i crediti** dell'organizzatore (o si
  registra per fatturazione Stripe). Nessun nuovo punto di misura.

## Modifiche per file (stima)

| Area | File | Intervento |
| --- | --- | --- |
| Protocollo | `shared/protocol.ts` | `join` accetta uno slug d'evento pre-esistente; messaggi di stato scheduled/live. |
| Runtime stanza | `server/src/rooms.ts` | Idratazione `Room` da record `event`; hook di fine-evento verso il metering→crediti. |
| Server | `server/src/index.ts` | Nuovo layer HTTP: `/auth/*`, CRUD `/events`, lookup slug→event. |
| DB | _nuovo_ `server/src/db.ts` | Accesso SQLite, migrazioni minime. |
| Web | _nuovo_ area organizzatore | Login, lista eventi, form «nuovo evento», link/QR. |
| Web | onboarding | Un link d'evento pre-creato entra come oggi (nessun cambiamento per il pubblico). |

## Fasi consigliate

1. **DB + persistenza eventi** (SQLite, tabelle, idratazione `Room`).
   _Complessità: media._ Sblocca già «eventi in anticipo» con link stabile,
   anche prima dell'auth (chiave segreta d'evento invece del login).
2. **Auth organizzatore** (magic-link) + area «i miei eventi».
   _Complessità: media._
3. **Billing**: crediti prepagati e/o Stripe, agganciati al metering esistente.
   _Complessità: alta_ (soprattutto la parte fiscale/pagamenti, non il codice).

## Cosa NON cambia

- Il pubblico non fa login e non installa nulla.
- La meccanica audio, il PTT half-duplex, l'instradamento per parlante e la
  modalità evento restano identici: aggiungiamo **proprietà e persistenza**,
  non nuovi percorsi audio.
- In fase NAS resta tutto self-hosted; il DB è un file. Il passaggio a
  Postgres/cloud è una sostituzione di `db.ts`, non un rifacimento.

---

_Numeri di costo e prestazioni: vedi il calcolatore interattivo condiviso a
parte. I costi motore vivono in `server/src/rooms.ts`._
