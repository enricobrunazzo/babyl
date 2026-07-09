# Deploy su Synology DS920+ (Docker + reverse proxy DSM)

Babyl gira in **un solo container**: il server Node serve sia la web app
statica sia il WebSocket di segnalazione sulla porta `8787`. Nel reverse
proxy di DSM configuri quindi **un solo vhost**.

L'immagine viene buildata automaticamente da GitHub Actions a ogni push su
`main` e pubblicata su `ghcr.io/enricobrunazzo/babyl:latest`.

## Prerequisiti

- DSM 7.x con **Container Manager** installato (Centro pacchetti)
- Un dominio o sottodominio che punta al tuo IP pubblico (es. DDNS Synology
  `xxx.synology.me`, oppure un record A/CNAME tipo `babyl.tuodominio.it`)
- Porta **443** inoltrata dal router al NAS
- Certificato TLS valido in DSM (Let's Encrypt integrato) — **obbligatorio**:
  senza HTTPS i browser non danno accesso al microfono (`getUserMedia`)

## Passo 0 — Rendi pubblica l'immagine GHCR (una tantum)

Al primo push il pacchetto GHCR nasce privato. Rendilo pubblico così il NAS
lo scarica senza login:

1. GitHub → profilo → **Packages** → `babyl`
2. **Package settings** → **Danger zone** → *Change visibility* → **Public**

(In alternativa puoi fare `docker login ghcr.io` sul NAS con un Personal
Access Token con scope `read:packages`.)

## Passo 1 — Crea il progetto in Container Manager

1. Apri **Container Manager** → **Progetto** → **Crea**
2. Nome progetto: `babyl`
3. Percorso: una cartella dedicata, es. `/docker/babyl`
4. Origine: **Crea docker-compose.yml** e incolla:

   ```yaml
   services:
     babyl:
       image: ghcr.io/enricobrunazzo/babyl:latest
       container_name: babyl
       restart: unless-stopped
       ports:
         - "8787:8787"
       environment:
         # Traduzione simultanea (OpenAI Realtime). Senza questa riga l'app
         # funziona in modalità "voce originale", senza traduzione.
         - OPENAI_API_KEY=sk-INCOLLA-QUI-LA-TUA-KEY
   ```

   La API key si crea su https://platform.openai.com/api-keys (serve un
   account con credito a consumo). Resta solo sul NAS, non è mai esposta
   ai browser degli utenti.

5. **Avanti** → **Fine**. Container Manager scarica l'immagine e avvia il
   container.

Verifica dal browser, dentro la LAN: `http://<IP-del-NAS>:8787/healthz`
deve rispondere `{"ok":true}` e `http://<IP-del-NAS>:8787/` deve mostrare
l'onboarding di Babyl.

## Passo 2 — Reverse proxy DSM

1. **Pannello di controllo** → **Portale di accesso** → scheda
   **Avanzate** → **Reverse Proxy** → **Crea**
2. Compila:

   | Campo | Valore |
   | --- | --- |
   | Nome | `babyl` |
   | Origine — Protocollo | `HTTPS` |
   | Origine — Nome host | `babyl.tuodominio.it` (o il tuo DDNS) |
   | Origine — Porta | `443` |
   | Abilita HSTS | ✔ (consigliato) |
   | Destinazione — Protocollo | `HTTP` |
   | Destinazione — Nome host | `localhost` |
   | Destinazione — Porta | `8787` |

3. **Fondamentale per il WebSocket**: nella stessa finestra, scheda
   **Intestazione personalizzata** → **Crea** → **WebSocket**. DSM aggiunge
   da solo le due intestazioni `Upgrade` e `Connection`. Senza questo passo
   la pagina si carica ma resta su "Connessione alla stanza…".
4. (Opzionale) Scheda **Impostazioni avanzate**: porta **Proxy timeout** a
   un valore alto (es. `3600`). Il server invia comunque un ping ogni 30 s
   che tiene viva la connessione, e il client si riconnette da solo con
   backoff, ma un timeout ampio evita micro-interruzioni.

## Passo 3 — Certificato

1. **Pannello di controllo** → **Sicurezza** → **Certificato**
2. Se non l'hai già: **Aggiungi** → Let's Encrypt per `babyl.tuodominio.it`
3. **Impostazioni** → associa il certificato alla voce reverse proxy `babyl`

## Passo 4 — Collaudo

1. Da fuori dalla LAN (es. smartphone in 4G): `https://babyl.tuodominio.it`
2. Consenti il microfono, scegli un nome, **ENTRA**
3. Apri la stessa stanza da un secondo dispositivo:
   `https://babyl.tuodominio.it/?room=demo`
4. Tieni premuto il pulsante: sull'altro dispositivo deve diventare grigio
   con *«Nome» sta parlando…* e devi sentire l'audio

## Aggiornamenti automatici

A ogni push su `main` GitHub Actions pubblica una nuova `latest`. Aggiungendo
al progetto il servizio **watchtower** (già incluso nel `docker-compose.yml`
del repo), il NAS si aggiorna da solo:

```yaml
  watchtower:
    image: containrrr/watchtower:latest
    container_name: babyl-watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - WATCHTOWER_LABEL_ENABLE=true
      - WATCHTOWER_CLEANUP=true
      - WATCHTOWER_POLL_INTERVAL=300
```

e, nel servizio `babyl`, l'etichetta che lo autorizza all'aggiornamento:

```yaml
    labels:
      - com.centurylinklabs.watchtower.enable=true
```

Watchtower controlla GHCR ogni 5 minuti (`WATCHTOWER_POLL_INTERVAL`), scarica
la nuova immagine, ricrea il container preservando le variabili d'ambiente
(API key inclusa) ed elimina le immagini vecchie (`WATCHTOWER_CLEANUP`).
Tempo tipico da push a NAS aggiornato: 5–10 minuti (build GitHub + polling).

Note:
- il montaggio di `/var/run/docker.sock` dà a watchtower il controllo di
  Docker sul NAS; `WATCHTOWER_LABEL_ENABLE=true` lo limita ai soli container
  etichettati, quindi non tocca gli altri tuoi container;
- l'aggiornamento riavvia `babyl`: le stanze attive in quel momento si
  riconnettono da sole (il client ha la riconnessione automatica), ma chi
  stava parlando perde l'enunciato in corso.

### Aggiornamento manuale (alternativa)

- Container Manager → **Progetto** → `babyl` → **Azione** → **Pulisci e
  ricostruisci**, oppure
- via SSH: `docker compose -f /volume1/docker/babyl/docker-compose.yml pull
  && docker compose -f /volume1/docker/babyl/docker-compose.yml up -d`

## Risoluzione problemi

| Sintomo | Causa probabile |
| --- | --- |
| Bloccato su "Connessione alla stanza…" | Manca l'intestazione WebSocket nel reverse proxy (Passo 2.3) |
| "Microfono non disponibile" | Stai usando HTTP o un certificato non valido: serve HTTPS |
| I due utenti si vedono ma non si sentono | NAT restrittivo: serve un TURN server (vedi sotto) |
| Il container non parte | `docker logs babyl` via SSH; verifica che la porta 8787 sia libera |

## Opzionale — TURN server per NAT restrittivi

Con STUN pubblico la maggior parte delle reti domestiche/mobili funziona.
Se alcuni utenti si vedono ma l'audio non passa (NAT simmetrici, reti
aziendali), aggiungi **coturn** al progetto:

```yaml
  coturn:
    image: coturn/coturn:latest
    container_name: babyl-turn
    restart: unless-stopped
    network_mode: host
    command: >
      --listening-port=3478
      --fingerprint
      --lt-cred-mech
      --user=babyl:SCEGLI-UNA-PASSWORD
      --realm=babyl.tuodominio.it
      --external-ip=$$(detect-external-ip)
      --min-port=49160 --max-port=49200
    # Sul router inoltra al NAS: 3478 TCP/UDP e 49160-49200 UDP
```

Poi comunica al client gli ICE server: su GitHub → repo → **Settings** →
**Secrets and variables** → **Actions** → **Variables** → nuova variabile

```
VITE_ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:babyl.tuodominio.it:3478","username":"babyl","credential":"SCEGLI-UNA-PASSWORD"}]
```

e rilancia il workflow **Docker** (o fai un push): la configurazione viene
incorporata nel bundle web al build dell'immagine. Aggiorna quindi il
container sul NAS.
