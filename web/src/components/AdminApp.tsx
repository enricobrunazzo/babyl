import { useEffect, useRef, useState, type FormEvent } from "react";
import { BabylMark } from "./BabylLogo";
import {
  ApiError,
  clearToken,
  getMetrics,
  getSettings,
  getToken,
  setToken,
  updateSettings,
  type AppSettings,
  type Metrics,
} from "../lib/organizerApi";

const TIMINGS = [
  { value: "streaming", label: "Conversazione (simultanea)" },
  { value: "interview", label: "Intervista (frasi intere)" },
  { value: "consecutive", label: "Consecutiva (al rilascio)" },
];

const USD_TO_EUR = 0.92;

/**
 * Pannello admin (rotta `/admin`): regola le impostazioni di default (tempistica
 * stanze ed eventi) e mostra una dashboard dei consumi in tempo reale con la
 * stima di spesa. Autenticato col token admin, come l'area organizzatore.
 */
export function AdminApp() {
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
      await getSettings();
      onAuthed();
    } catch (err) {
      clearToken();
      setError(
        err instanceof ApiError && err.status === 404
          ? "Admin disattivato: configura BABYL_ADMIN_TOKEN sul server."
          : "Token non valido.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="onboarding org-gate">
      <div className="brand">
        <BabylMark size={44} />
        <h1>babyl</h1>
        <p>Pannello admin</p>
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
  return (
    <main className="admin">
      <header className="org-header">
        <div className="org-title">
          <BabylMark size={30} />
          <h1>Admin</h1>
        </div>
        <button
          className="ghost-button"
          type="button"
          onClick={() => {
            clearToken();
            onLogout();
          }}
        >
          Esci
        </button>
      </header>

      <SettingsPanel />
      <MetricsPanel />
    </main>
  );
}

function SettingsPanel() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSettings().then(setSettings).catch(() => setError("Errore nel caricamento."));
  }, []);

  const change = async (patch: Partial<AppSettings>) => {
    setError(null);
    try {
      const next = await updateSettings(patch);
      setSettings(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      setError("Impossibile salvare.");
    }
  };

  return (
    <section className="admin-card">
      <div className="admin-card-head">
        <h2>Impostazioni di default</h2>
        {saved && <span className="admin-saved">Salvato ✓</span>}
      </div>
      <p className="admin-sub">
        Valgono per le <b>nuove</b> stanze/eventi. Gli eventi già creati
        conservano la loro tempistica.
      </p>
      {error && (
        <p className="translation-error" role="status">
          {error}
        </p>
      )}
      {settings && (
        <div className="admin-settings">
          <label className="field">
            <span>Tempistica di default · Stanze</span>
            <select
              value={settings.defaultTiming}
              onChange={(e) => change({ defaultTiming: e.target.value })}
            >
              {TIMINGS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Tempistica di default · Eventi</span>
            <select
              value={settings.eventDefaultTiming}
              onChange={(e) => change({ eventDefaultTiming: e.target.value })}
            >
              {TIMINGS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </section>
  );
}

const MB = (bytes: number) => (bytes / 1_000_000).toFixed(1);
const MIN = (ms: number) => (ms / 60_000).toFixed(1);

function MetricsPanel() {
  const [m, setM] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const load = async () => {
    try {
      setM(await getMetrics());
      setError(null);
    } catch {
      setError("Consumi non disponibili.");
    }
  };

  useEffect(() => {
    void load();
    timer.current = window.setInterval(load, 5000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, []);

  const costEur = m ? m.estCostUsd * USD_TO_EUR : 0;
  const rooms = m ? Object.entries(m.perRoom) : [];

  return (
    <section className="admin-card">
      <div className="admin-card-head">
        <h2>Consumi &amp; spesa</h2>
        <button className="ghost-button" type="button" onClick={() => void load()}>
          Aggiorna
        </button>
      </div>
      {error && (
        <p className="translation-error" role="status">
          {error}
        </p>
      )}
      {m && (
        <>
          <div className="admin-stats">
            <Stat label="Stanze attive" value={String(m.rooms)} />
            <Stat label="Partecipanti" value={String(m.peers)} />
            <Stat
              label="Uptime"
              value={`${Math.floor(m.uptimeSec / 3600)}h ${Math.floor((m.uptimeSec % 3600) / 60)}m`}
            />
            <Stat
              label="Stima spesa motore"
              value={`$${m.estCostUsd.toFixed(2)}`}
              sub={`≈ €${costEur.toFixed(2)}`}
              accent
            />
          </div>

          <div className="admin-breakdown">
            <Row k="Minuti motore · ingresso" v={`${MIN(m.totals.inMs)} min`} />
            <Row k="Minuti motore · uscita" v={`${MIN(m.totals.outMs)} min`} />
            <Row k="Tempo di canale (PTT)" v={`${MIN(m.totals.pttMs)} min`} />
            <Row
              k="Traffico audio (in / out)"
              v={`${MB(m.totals.bytesIn)} / ${MB(m.totals.bytesOut)} MB`}
            />
          </div>

          <h3 className="admin-h3">Stanze vive</h3>
          {rooms.length === 0 ? (
            <p className="org-empty">Nessuna stanza attiva ora.</p>
          ) : (
            <div className="admin-rooms">
              {rooms.map(([id, s]) => (
                <div key={id} className="admin-room">
                  <div className="admin-room-top">
                    <b>{id}</b>
                    <span>{s.peers} 👤</span>
                  </div>
                  <div className="admin-pairs">
                    {Object.entries(s.pairs).length === 0 ? (
                      <span className="admin-muted">nessuna traduzione</span>
                    ) : (
                      Object.entries(s.pairs).map(([pair, p]) => (
                        <span key={pair} className="admin-pair">
                          {pair.replace("->", "→")} · {MIN(p.outMs)}m out
                        </span>
                      ))
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <p className="admin-foot">
            Aggiornamento ogni 5s. Stima a $0,06/min in + $0,24/min out per coppia
            di lingue. Per proiezioni: <a href="/configuratore">/configuratore</a>.
          </p>
        </>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className={`admin-stat${accent ? " accent" : ""}`}>
      <span className="k">{label}</span>
      <span className="v">{value}</span>
      {sub && <span className="s">{sub}</span>}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="admin-row">
      <span>{k}</span>
      <span className="val">{v}</span>
    </div>
  );
}
