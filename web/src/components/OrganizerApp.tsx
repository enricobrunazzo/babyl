import { useEffect, useRef, useState, type FormEvent } from "react";
import { LANGUAGES } from "../lib/languages";
import { QRCode } from "./QRCode";
import { BabylMark } from "./BabylLogo";
import {
  ApiError,
  clearToken,
  createEvent,
  eventPublicLink,
  getEmail,
  getToken,
  listEvents,
  setEmail as storeEmail,
  setToken,
  type OrgEvent,
} from "../lib/organizerApi";

const TIMINGS = [
  { value: "streaming", label: "Conversazione (simultanea)" },
  { value: "interview", label: "Intervista (frasi intere)" },
  { value: "consecutive", label: "Consecutiva (al rilascio del microfono)" },
];

const STATUS_LABEL: Record<string, string> = {
  scheduled: "Programmato",
  live: "In corso",
  ended: "Concluso",
};

/**
 * Area organizzatore (rotta `/organizer`): crea in anticipo eventi con link
 * stabile e QR, e li rivede. Operatore singolo, autenticato col token admin.
 */
export function OrganizerApp() {
  const [authed, setAuthed] = useState(() => Boolean(getToken()));
  return authed ? (
    <Dashboard onLogout={() => setAuthed(false)} />
  ) : (
    <TokenGate onAuthed={() => setAuthed(true)} />
  );
}

function TokenGate({ onAuthed }: { onAuthed: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setToken(value);
    setBusy(true);
    setError(null);
    try {
      await listEvents(); // valida il token
      onAuthed();
    } catch (err) {
      clearToken();
      if (err instanceof ApiError && err.status === 404) {
        setError(
          "API eventi disattivata sul server: configura BABYL_ADMIN_TOKEN.",
        );
      } else {
        setError("Token non valido.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="onboarding org-gate">
      <div className="brand">
        <BabylMark size={44} />
        <h1>babyl</h1>
        <p>Area organizzatore</p>
      </div>
      <form className="onboarding-form" onSubmit={submit}>
        <label className="field">
          <span>Token admin</span>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="BABYL_ADMIN_TOKEN"
            autoFocus
          />
        </label>
        {error && (
          <p className="translation-error" role="status">
            {error}
          </p>
        )}
        <button className="enter-button" type="submit" disabled={busy}>
          {busy ? "Verifica…" : "Entra"}
        </button>
      </form>
    </main>
  );
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [events, setEvents] = useState<OrgEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Solo l'ultimo refresh vince: due caricamenti sovrapposti (mount + dopo la
  // creazione) possono risolversi fuori ordine, e una risposta vecchia (vuota)
  // non deve sovrascrivere quella nuova.
  const reqId = useRef(0);

  const refresh = async () => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const list = await listEvents();
      if (id === reqId.current) {
        setEvents(list);
        setError(null);
      }
    } catch {
      if (id === reqId.current) setError("Impossibile caricare gli eventi.");
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const logout = () => {
    clearToken();
    onLogout();
  };

  return (
    <main className="org">
      <header className="org-header">
        <div className="org-title">
          <BabylMark size={30} />
          <h1>Eventi</h1>
        </div>
        <button className="ghost-button" type="button" onClick={logout}>
          Esci
        </button>
      </header>

      <CreateEventForm
        onCreated={(ev) =>
          setEvents((prev) => [ev, ...prev.filter((e) => e.id !== ev.id)])
        }
      />

      <section className="org-list">
        <div className="org-list-head">
          <h2>I tuoi eventi</h2>
          <button
            className="ghost-button"
            type="button"
            onClick={() => void refresh()}
          >
            Aggiorna
          </button>
        </div>
        {loading ? (
          <p className="org-empty">Caricamento…</p>
        ) : error ? (
          <p className="translation-error" role="status">
            {error}
          </p>
        ) : events.length === 0 ? (
          <p className="org-empty">
            Nessun evento ancora. Creane uno qui sopra.
          </p>
        ) : (
          <div className="org-cards">
            {events.map((ev) => (
              <EventCard key={ev.id} event={ev} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function CreateEventForm({
  onCreated,
}: {
  onCreated: (event: OrgEvent) => void;
}) {
  const [title, setTitle] = useState("");
  const [email, setEmail] = useState(getEmail);
  const [langs, setLangs] = useState<string[]>(["it"]);
  const [timing, setTiming] = useState("streaming");
  const [when, setWhen] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleLang = (code: string) =>
    setLangs((cur) =>
      cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code],
    );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return setError("Serve un titolo.");
    if (!email.includes("@")) return setError("Email organizzatore non valida.");
    if (langs.length === 0) return setError("Scegli almeno una lingua.");
    setBusy(true);
    try {
      const event = await createEvent({
        organizerEmail: email.trim(),
        title: title.trim(),
        listenLangs: langs,
        timing,
        slug: slug.trim() || undefined,
        scheduledAt: when ? new Date(when).getTime() : null,
      });
      storeEmail(email);
      setTitle("");
      setSlug("");
      setWhen("");
      onCreated(event);
    } catch (err) {
      setError(
        err instanceof ApiError ? mapError(err.message) : "Errore di rete.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="org-create">
      <h2>Nuovo evento</h2>
      <form className="org-form" onSubmit={submit}>
        <label className="field">
          <span>Titolo</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Es. Conferenza · Piazza"
          />
        </label>

        <label className="field">
          <span>Email organizzatore</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="tu@esempio.it"
          />
        </label>

        <div className="field">
          <span>Lingue d'ascolto</span>
          <div className="org-langs">
            {LANGUAGES.map((l) => (
              <button
                key={l.code}
                type="button"
                className={`org-lang${langs.includes(l.code) ? " on" : ""}`}
                onClick={() => toggleLang(l.code)}
                aria-pressed={langs.includes(l.code)}
              >
                <span aria-hidden="true">{l.flag}</span> {l.nativeName}
              </button>
            ))}
          </div>
        </div>

        <div className="org-row">
          <label className="field">
            <span>Tempistica</span>
            <select value={timing} onChange={(e) => setTiming(e.target.value)}>
              {TIMINGS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Data e ora (opzionale)</span>
            <input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </label>
        </div>

        <label className="field">
          <span>Slug del link (opzionale)</span>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="generato dal titolo se vuoto"
          />
        </label>

        {error && (
          <p className="translation-error" role="status">
            {error}
          </p>
        )}
        <button className="enter-button" type="submit" disabled={busy}>
          {busy ? "Creazione…" : "Crea evento"}
        </button>
      </form>
    </section>
  );
}

function EventCard({ event }: { event: OrgEvent }) {
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);
  const link = eventPublicLink(event.slug);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard non disponibile */
    }
  };

  const flags = event.listenLangs
    .map((c) => LANGUAGES.find((l) => l.code === c)?.flag ?? c)
    .join(" ");

  return (
    <article className="org-card">
      <div className="org-card-top">
        <h3>{event.title}</h3>
        <span className={`org-status org-status-${event.status}`}>
          {STATUS_LABEL[event.status] ?? event.status}
        </span>
      </div>
      <div className="org-meta">
        <span className="org-slug">/{event.slug}</span>
        <span aria-hidden="true">{flags}</span>
        {event.scheduledAt && (
          <span>
            {new Date(event.scheduledAt).toLocaleString("it-IT", {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </span>
        )}
      </div>

      <div className="org-link">
        <input readOnly value={link} onFocus={(e) => e.target.select()} />
        <button type="button" onClick={copy}>
          {copied ? "Copiato!" : "Copia"}
        </button>
        <button type="button" onClick={() => setShowQr((v) => !v)}>
          {showQr ? "Nascondi QR" : "QR"}
        </button>
      </div>

      {showQr && (
        <div className="org-qr">
          <QRCode text={link} size={200} />
        </div>
      )}
    </article>
  );
}

/** Traduce i codici d'errore del server in messaggi leggibili. */
function mapError(code: string): string {
  const map: Record<string, string> = {
    "email-invalida": "Email organizzatore non valida.",
    "titolo-mancante": "Serve un titolo.",
    "lingue-mancanti": "Scegli almeno una lingua.",
    "slug-non-disponibile": "Slug non disponibile, provane un altro.",
    "non-autorizzato": "Token scaduto: rientra.",
  };
  return map[code] ?? "Errore nella creazione dell'evento.";
}
