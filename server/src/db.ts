/**
 * Persistenza (fase NAS, un solo container): SQLite via il modulo **integrato**
 * `node:sqlite` — zero dipendenze, nessun modulo nativo da compilare su Alpine.
 *
 * Tutte le query stanno dietro questa piccola interfaccia: se un domani
 * `node:sqlite` (marcato experimental) desse fastidio si passa a
 * `better-sqlite3`, e nella futura fase cloud **multi-istanza** a Postgres/Neon,
 * senza toccare il resto del server. Il runtime delle stanze resta in memoria;
 * qui vivono solo i metadati a riposo: organizzatori ed eventi programmati.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TranslationTiming } from "../../shared/protocol.ts";

/** Stato di un evento nel suo ciclo di vita. */
export type EventStatus = "scheduled" | "live" | "ended";

export interface Organizer {
  id: number;
  email: string;
  createdAt: number;
  /** Crediti residui in secondi di inferenza (metering → billing). */
  creditsSeconds: number;
  stripeCustomerId: string | null;
}

export interface EventRecord {
  id: number;
  /** Nome-stanza stabile deciso in anticipo: è il link condiviso. */
  slug: string;
  organizerId: number;
  title: string;
  /** Lingue d'ascolto attese. */
  listenLangs: string[];
  timing: TranslationTiming;
  /** Epoch ms della partenza prevista (null = nessuna programmazione). */
  scheduledAt: number | null;
  expiresAt: number | null;
  /** Hash della chiave segreta che abilita il relatore quando l'evento va live. */
  hostResumeKeyHash: string | null;
  status: EventStatus;
  createdAt: number;
}

/** Dati per creare un evento; i campi opzionali hanno default sensati. */
export interface NewEvent {
  slug: string;
  organizerId: number;
  title: string;
  listenLangs: string[];
  timing: TranslationTiming;
  scheduledAt?: number | null;
  expiresAt?: number | null;
  hostResumeKeyHash?: string | null;
  status?: EventStatus;
}

/**
 * Migrazioni incrementali. Ogni voce è l'insieme di statement per passare dalla
 * versione i alla i+1; l'indice nell'array è la versione. Si applicano in
 * transazione e `PRAGMA user_version` tiene il conto — micro-migratore, niente
 * ORM, coerente con lo stile minimalista del server.
 */
const MIGRATIONS: readonly string[] = [
  // v0 → v1: schema iniziale (organizzatori + eventi programmati).
  `
  CREATE TABLE organizer (
    id                 INTEGER PRIMARY KEY,
    email              TEXT    NOT NULL UNIQUE,
    created_at         INTEGER NOT NULL,
    credits_seconds    INTEGER NOT NULL DEFAULT 0,
    stripe_customer_id TEXT
  );

  CREATE TABLE event (
    id                   INTEGER PRIMARY KEY,
    slug                 TEXT    NOT NULL UNIQUE,
    organizer_id         INTEGER NOT NULL REFERENCES organizer(id) ON DELETE CASCADE,
    title                TEXT    NOT NULL,
    listen_langs         TEXT    NOT NULL,
    timing               TEXT    NOT NULL,
    scheduled_at         INTEGER,
    expires_at           INTEGER,
    host_resume_key_hash TEXT,
    status               TEXT    NOT NULL DEFAULT 'scheduled',
    created_at           INTEGER NOT NULL
  );

  CREATE INDEX idx_event_organizer ON event(organizer_id);
  `,
];

interface OrganizerRow {
  id: number;
  email: string;
  created_at: number;
  credits_seconds: number;
  stripe_customer_id: string | null;
}

interface EventRow {
  id: number;
  slug: string;
  organizer_id: number;
  title: string;
  listen_langs: string;
  timing: string;
  scheduled_at: number | null;
  expires_at: number | null;
  host_resume_key_hash: string | null;
  status: string;
  created_at: number;
}

function toOrganizer(r: OrganizerRow): Organizer {
  return {
    id: r.id,
    email: r.email,
    createdAt: r.created_at,
    creditsSeconds: r.credits_seconds,
    stripeCustomerId: r.stripe_customer_id,
  };
}

function toEvent(r: EventRow): EventRecord {
  return {
    id: r.id,
    slug: r.slug,
    organizerId: r.organizer_id,
    title: r.title,
    listenLangs: JSON.parse(r.listen_langs) as string[],
    timing: r.timing as TranslationTiming,
    scheduledAt: r.scheduled_at,
    expiresAt: r.expires_at,
    hostResumeKeyHash: r.host_resume_key_hash,
    status: r.status as EventStatus,
    createdAt: r.created_at,
  };
}

/** Percorso di default del file DB (creabile via env `BABYL_DB_PATH`). */
export function defaultDbPath(): string {
  return (
    process.env.BABYL_DB_PATH ??
    fileURLToPath(new URL("../../data/babyl.db", import.meta.url))
  );
}

/**
 * Accesso al database. Sincrono di proposito: i metadati sono a basso volume e
 * fuori dai percorsi audio caldi, quindi l'API sincrona di `node:sqlite`
 * semplifica il codice senza costi pratici.
 */
export class Db {
  private readonly db: DatabaseSync;

  /**
   * @param path percorso del file SQLite, oppure `":memory:"` (test). Per un
   * file, la cartella viene creata se manca e si abilita la modalità WAL.
   */
  constructor(path: string = defaultDbPath()) {
    const memory = path === ":memory:";
    if (!memory) mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON");
    if (!memory) this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  /** Applica le migrazioni mancanti in transazione, aggiornando user_version. */
  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v]);
        // v è un intero controllato: interpolazione sicura (PRAGMA non accetta bind).
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  /** Versione dello schema attualmente applicata (per test/diagnostica). */
  schemaVersion(): number {
    return (this.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    }).user_version;
  }

  // --- Organizzatori ---

  createOrganizer(email: string, creditsSeconds = 0): Organizer {
    const { lastInsertRowid } = this.db
      .prepare(
        "INSERT INTO organizer(email, created_at, credits_seconds) VALUES(?, ?, ?)",
      )
      .run(email, Date.now(), creditsSeconds);
    return this.getOrganizer(Number(lastInsertRowid))!;
  }

  getOrganizer(id: number): Organizer | null {
    const r = this.db
      .prepare("SELECT * FROM organizer WHERE id = ?")
      .get(id) as OrganizerRow | undefined;
    return r ? toOrganizer(r) : null;
  }

  getOrganizerByEmail(email: string): Organizer | null {
    const r = this.db
      .prepare("SELECT * FROM organizer WHERE email = ?")
      .get(email) as OrganizerRow | undefined;
    return r ? toOrganizer(r) : null;
  }

  /** Aggiunge crediti (ricarica). Ritorna il saldo aggiornato. */
  addCredits(organizerId: number, seconds: number): number {
    this.db
      .prepare(
        "UPDATE organizer SET credits_seconds = credits_seconds + ? WHERE id = ?",
      )
      .run(seconds, organizerId);
    return this.getOrganizer(organizerId)?.creditsSeconds ?? 0;
  }

  /**
   * Scala crediti in modo transazionale (fine evento → metering). Non scende
   * sotto zero: consuma al massimo il residuo. Ritorna i secondi effettivamente
   * scalati.
   */
  consumeCredits(organizerId: number, seconds: number): number {
    if (seconds <= 0) return 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const cur = this.db
        .prepare("SELECT credits_seconds FROM organizer WHERE id = ?")
        .get(organizerId) as { credits_seconds: number } | undefined;
      if (!cur) {
        this.db.exec("ROLLBACK");
        return 0;
      }
      const used = Math.min(cur.credits_seconds, seconds);
      this.db
        .prepare("UPDATE organizer SET credits_seconds = credits_seconds - ? WHERE id = ?")
        .run(used, organizerId);
      this.db.exec("COMMIT");
      return used;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // --- Eventi ---

  createEvent(e: NewEvent): EventRecord {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO event
           (slug, organizer_id, title, listen_langs, timing,
            scheduled_at, expires_at, host_resume_key_hash, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.slug,
        e.organizerId,
        e.title,
        JSON.stringify(e.listenLangs),
        e.timing,
        e.scheduledAt ?? null,
        e.expiresAt ?? null,
        e.hostResumeKeyHash ?? null,
        e.status ?? "scheduled",
        Date.now(),
      );
    return this.getEvent(Number(lastInsertRowid))!;
  }

  getEvent(id: number): EventRecord | null {
    const r = this.db
      .prepare("SELECT * FROM event WHERE id = ?")
      .get(id) as EventRow | undefined;
    return r ? toEvent(r) : null;
  }

  getEventBySlug(slug: string): EventRecord | null {
    const r = this.db
      .prepare("SELECT * FROM event WHERE slug = ?")
      .get(slug) as EventRow | undefined;
    return r ? toEvent(r) : null;
  }

  listEventsByOrganizer(organizerId: number): EventRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM event WHERE organizer_id = ? ORDER BY COALESCE(scheduled_at, created_at) DESC",
      )
      .all(organizerId) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  /** Tutti gli eventi (vista admin / operatore singolo), più recenti prima. */
  listEvents(): EventRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM event ORDER BY COALESCE(scheduled_at, created_at) DESC",
      )
      .all() as unknown as EventRow[];
    return rows.map(toEvent);
  }

  setEventStatus(id: number, status: EventStatus): void {
    this.db.prepare("UPDATE event SET status = ? WHERE id = ?").run(status, id);
  }

  close(): void {
    this.db.close();
  }
}
