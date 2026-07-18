/**
 * API HTTP minima per gli **eventi programmati** (Fase 1). Permette di creare in
 * anticipo un evento con link stabile e di rileggerlo. È volutamente separata
 * dal WebSocket del pubblico: non tocca join, stanze né audio.
 *
 * Autenticazione provvisoria: un token admin condiviso (`BABYL_ADMIN_TOKEN`).
 * L'account organizzatore vero e proprio (magic-link) arriva nella fase 2; se il
 * token non è configurato, l'API è disattivata (404) e il server resta identico
 * a oggi.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Db, type EventRecord } from "./db.ts";
import {
  TRANSLATION_TIMINGS,
  type TranslationTiming,
} from "../../shared/protocol.ts";

/** Corpo massimo accettato su POST (i metadati evento sono piccoli). */
const MAX_BODY_BYTES = 16 * 1024;

export interface CreateEventInput {
  organizerEmail: string;
  title: string;
  listenLangs: string[];
  timing?: string;
  /** Slug desiderato; se assente o già preso, se ne genera uno univoco. */
  slug?: string;
  scheduledAt?: number | null;
}

/** Valida una tempistica arbitraria ("release" resta alias di "consecutive"). */
export function parseTiming(value: unknown): TranslationTiming {
  if (value === "release") return "consecutive";
  return (TRANSLATION_TIMINGS as readonly string[]).includes(
    typeof value === "string" ? value : "",
  )
    ? (value as TranslationTiming)
    : "streaming";
}

/** Rende un titolo in uno slug URL-safe (lettere/numeri separati da trattini). */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // toglie i segni diacritici
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Suffisso breve per disambiguare slug in collisione. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

/**
 * Crea un evento per un organizzatore (creato al volo dalla sua email se nuovo).
 * Genera uno slug univoco a partire da quello richiesto (o dal titolo).
 * Lancia `Error` con `.status` per input non validi.
 */
export function createEventForOrganizer(
  db: Db,
  input: CreateEventInput,
): EventRecord {
  const email = String(input.organizerEmail ?? "").trim().toLowerCase();
  const title = String(input.title ?? "").trim();
  const langs = Array.isArray(input.listenLangs)
    ? input.listenLangs
        .map((l) => String(l).slice(0, 12).trim())
        .filter(Boolean)
    : [];
  if (!email || !email.includes("@")) throw httpError(400, "email-invalida");
  if (!title) throw httpError(400, "titolo-mancante");
  if (langs.length === 0) throw httpError(400, "lingue-mancanti");

  const organizer =
    db.getOrganizerByEmail(email) ?? db.createOrganizer(email);

  const base = slugify(input.slug || title) || "evento";
  let slug = base;
  for (let i = 0; i < 6 && db.getEventBySlug(slug); i++) {
    slug = `${base}-${randomSuffix()}`;
  }
  if (db.getEventBySlug(slug)) throw httpError(409, "slug-non-disponibile");

  return db.createEvent({
    slug,
    organizerId: organizer.id,
    title,
    listenLangs: langs,
    timing: parseTiming(input.timing),
    scheduledAt:
      typeof input.scheduledAt === "number" ? input.scheduledAt : null,
  });
}

interface HttpError extends Error {
  status: number;
}
function httpError(status: number, message: string): HttpError {
  const err = new Error(message) as HttpError;
  err.status = status;
  return err;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, "corpo-troppo-grande"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(httpError(400, "json-non-valido"));
      }
    });
    req.on("error", reject);
  });
}

export interface ApiDeps {
  db: Db;
  adminToken: string | undefined;
}

/**
 * Gestisce le rotte `/api/*`. Ritorna `true` se ha gestito la richiesta (così
 * `index.ts` non prosegue verso lo statico), `false` se la URL non è dell'API.
 */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<boolean> {
  const url = (req.url ?? "").split("?")[0];
  if (!url.startsWith("/api/")) return false;

  // Feature-gate: senza token admin l'API è spenta.
  if (!deps.adminToken) {
    sendJson(res, 404, { error: "api-disabilitata" });
    return true;
  }
  if (req.headers["x-admin-token"] !== deps.adminToken) {
    sendJson(res, 401, { error: "non-autorizzato" });
    return true;
  }

  try {
    // GET /api/events/:slug
    const slugMatch = url.match(/^\/api\/events\/([^/]+)$/);
    if (slugMatch && req.method === "GET") {
      const ev = deps.db.getEventBySlug(decodeURIComponent(slugMatch[1]));
      if (!ev) {
        sendJson(res, 404, { error: "evento-non-trovato" });
        return true;
      }
      sendJson(res, 200, { event: ev });
      return true;
    }

    if (url === "/api/events" && req.method === "GET") {
      const email = new URL(req.url ?? "", "http://x").searchParams.get(
        "organizer",
      );
      const organizer = email
        ? deps.db.getOrganizerByEmail(email.toLowerCase())
        : null;
      const events = organizer
        ? deps.db.listEventsByOrganizer(organizer.id)
        : [];
      sendJson(res, 200, { events });
      return true;
    }

    if (url === "/api/events" && req.method === "POST") {
      const body = (await readJsonBody(req)) as CreateEventInput;
      const event = createEventForOrganizer(deps.db, body);
      sendJson(res, 201, { event });
      return true;
    }

    sendJson(res, 405, { error: "metodo-non-consentito" });
    return true;
  } catch (err) {
    const status = (err as HttpError).status ?? 500;
    sendJson(res, status, { error: (err as Error).message });
    return true;
  }
}
