/**
 * Client dell'API eventi per l'area organizzatore (single-device, operatore
 * singolo). Autenticazione provvisoria: token admin conservato in
 * localStorage e inviato come header `x-admin-token`. Nessun login vero finché
 * non arriva il magic-link multi-organizzatore.
 */
const TOKEN_KEY = "babyl.adminToken";
const EMAIL_KEY = "babyl.organizerEmail";

export interface OrgEvent {
  id: number;
  slug: string;
  organizerId: number;
  title: string;
  listenLangs: string[];
  timing: string;
  scheduledAt: number | null;
  expiresAt: number | null;
  status: string;
  createdAt: number;
}

export interface NewEventInput {
  organizerEmail: string;
  title: string;
  listenLangs: string[];
  timing: string;
  slug?: string;
  scheduledAt?: number | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const getToken = (): string => localStorage.getItem(TOKEN_KEY) ?? "";
export const setToken = (t: string): void =>
  localStorage.setItem(TOKEN_KEY, t.trim());
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

export const getEmail = (): string => localStorage.getItem(EMAIL_KEY) ?? "";
export const setEmail = (e: string): void =>
  localStorage.setItem(EMAIL_KEY, e.trim());

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-admin-token": getToken(),
      ...init?.headers,
    },
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* corpo vuoto o non-JSON */
  }
  if (!res.ok) {
    const message =
      (data as { error?: string })?.error ?? `errore ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export async function listEvents(): Promise<OrgEvent[]> {
  const { events } = await request<{ events: OrgEvent[] }>("/events");
  return events;
}

export async function createEvent(input: NewEventInput): Promise<OrgEvent> {
  const { event } = await request<{ event: OrgEvent }>("/events", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return event;
}

/** Link pubblico (pubblico = ascoltatore) di un evento: apre il join snello. */
export function eventPublicLink(slug: string): string {
  return `${location.origin}/?room=${encodeURIComponent(slug)}&event=1&join=1`;
}

/** Link del relatore: apre la stanza dell'evento come chi parla (host). */
export function eventHostLink(slug: string): string {
  return `${location.origin}/?room=${encodeURIComponent(slug)}&host=1`;
}
