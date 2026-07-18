import { useState } from "react";
import { BabylMark } from "./BabylLogo";

/**
 * Configuratore evento (rotta `/configuratore`): stima costo motore, ricavo e
 * margine muovendo i parametri. Porta in pagina il calcolatore già usato in
 * fase di pianificazione, con il linguaggio visivo di babyl e responsive su
 * desktop. Le tariffe di default sono quelle del motore configurato nel codice
 * (`server/src/rooms.ts`).
 */

const ENGINES = [
  { id: "realtime", label: "gpt-realtime", in: 0.06, out: 0.24 },
  { id: "mini", label: "mini*", in: 0.024, out: 0.1 },
  { id: "pipeline", label: "pipeline*", in: 0.006, out: 0.014 },
] as const;

const IN_RATE = 0.06;
const OUT_RATE = 0.24;
const KBIT_PER_LISTENER = 384;

const fmtEur = (v: number) =>
  "€" +
  (v >= 100
    ? Math.round(v).toLocaleString("it-IT")
    : v.toFixed(v < 10 ? 2 : 0).replace(".", ","));
const fmtUsd = (v: number) => "$" + v.toFixed(2).replace(".", ",");

export function Configuratore() {
  const [langs, setLangs] = useState(4);
  const [mins, setMins] = useState(40);
  const [people, setPeople] = useState(50);
  const [mode, setMode] = useState<"seat" | "event">("seat");
  const [seat, setSeat] = useState(5);
  const [eventPrice, setEventPrice] = useState(250);
  const [fx, setFx] = useState(0.92);
  const [inRate, setInRate] = useState(IN_RATE);
  const [outRate, setOutRate] = useState(OUT_RATE);
  const [engine, setEngine] = useState<string | null>("realtime");

  const engMin = langs * mins;
  const inUsd = engMin * inRate;
  const outUsd = engMin * outRate;
  const costEur = (inUsd + outUsd) * fx;
  const revenue = mode === "seat" ? seat * people : eventPrice;
  const profit = revenue - costEur;
  const marginPct = revenue > 0 ? (profit / revenue) * 100 : 0;
  const perHead = costEur / Math.max(1, people);
  const mbit = (people * KBIT_PER_LISTENER) / 1000;
  const perf =
    mbit > 120
      ? { cls: "hot", host: "serve più istanze / sharding" }
      : mbit > 40
        ? { cls: "warn", host: "serve una VM robusta" }
        : { cls: "", host: "gestibile da una VM modesta" };

  const pickEngine = (e: (typeof ENGINES)[number]) => {
    setEngine(e.id);
    setInRate(e.in);
    setOutRate(e.out);
  };

  return (
    <main className="cfg" dir="ltr">
      <header className="cfg-hero">
        <BabylMark size={44} />
        <h1>Configura il tuo evento</h1>
        <p>
          Muovi i parametri e vedi costo, ricavo e margine in tempo reale. Il
          costo scala con le <b>lingue d'ascolto</b>, non con le persone.
        </p>
      </header>

      <div className="cfg-grid">
        <section className="cfg-panel">
          <h2>Parametri</h2>

          <div className="cfg-ctrl">
            <span className="cfg-label">Motore (tariffe $/min per lingua)</span>
            <div className="cfg-seg">
              {ENGINES.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={engine === e.id ? "on" : ""}
                  onClick={() => pickEngine(e)}
                >
                  {e.label}
                </button>
              ))}
            </div>
            <div className="cfg-rates">
              <input
                type="number"
                step="0.001"
                min="0"
                value={inRate}
                onChange={(ev) => {
                  setInRate(Number(ev.target.value) || 0);
                  setEngine(null);
                }}
                aria-label="Tariffa ingresso $/min"
              />
              <input
                type="number"
                step="0.001"
                min="0"
                value={outRate}
                onChange={(ev) => {
                  setOutRate(Number(ev.target.value) || 0);
                  setEngine(null);
                }}
                aria-label="Tariffa uscita $/min"
              />
            </div>
            <small className="cfg-hint">
              in · out. <b>*</b> mini e pipeline sono stime da verificare sui
              listini.
            </small>
          </div>

          <Slider
            label="Lingue d'ascolto"
            value={langs}
            min={1}
            max={12}
            onChange={setLangs}
          />
          <Slider
            label="Minuti di parlato effettivo"
            value={mins}
            min={5}
            max={180}
            step={5}
            unit="min"
            onChange={setMins}
          />
          <Slider
            label="Persone in platea"
            value={people}
            min={2}
            max={500}
            onChange={setPeople}
          />

          <div className="cfg-ctrl">
            <span className="cfg-label">Come vendi</span>
            <div className="cfg-seg">
              <button
                type="button"
                className={mode === "seat" ? "on" : ""}
                onClick={() => setMode("seat")}
              >
                Per persona
              </button>
              <button
                type="button"
                className={mode === "event" ? "on" : ""}
                onClick={() => setMode("event")}
              >
                Prezzo fisso
              </button>
            </div>
          </div>

          {mode === "seat" ? (
            <Slider
              label="Prezzo per persona"
              value={seat}
              min={0}
              max={30}
              step={0.5}
              unit="€"
              onChange={setSeat}
            />
          ) : (
            <div className="cfg-ctrl">
              <span className="cfg-label">Prezzo evento (€)</span>
              <input
                type="number"
                className="cfg-num"
                min="0"
                step="10"
                value={eventPrice}
                onChange={(ev) => setEventPrice(Number(ev.target.value) || 0)}
              />
            </div>
          )}

          <Slider
            label="Cambio USD → EUR"
            value={fx}
            min={0.8}
            max={1.1}
            step={0.01}
            onChange={setFx}
            format={(v) => v.toFixed(2).replace(".", ",")}
          />
        </section>

        <section className="cfg-panel">
          <h2>Risultato</h2>
          <div className="cfg-result">
            <div className="cfg-rh cost">
              <span className="k">Costo motore</span>
              <span className="v">{fmtEur(costEur)}</span>
            </div>
            <div className="cfg-rh margin">
              <span className="k">Margine</span>
              <span
                className="v"
                style={{ color: marginPct >= 0 ? "var(--free)" : "var(--talking)" }}
              >
                {revenue > 0 ? Math.round(marginPct) : 0}%
              </span>
            </div>
            <div className="cfg-rh full">
              <span className="k">Ricavo · Utile</span>
              <span className="v small">
                {fmtEur(revenue)} ·{" "}
                <span style={{ color: profit >= 0 ? "var(--free)" : "var(--talking)" }}>
                  {fmtEur(profit)}
                </span>
              </span>
            </div>
          </div>

          <div className="cfg-breakdown">
            <div className="brow">
              <span>Ingresso motore · {engMin} min</span>
              <span className="val">{fmtUsd(inUsd)}</span>
            </div>
            <div className="brow">
              <span>Uscita motore · {engMin} min</span>
              <span className="val">{fmtUsd(outUsd)}</span>
            </div>
            <div className="brow accent">
              <span>Costo per persona</span>
              <span className="val">
                €{perHead.toFixed(2).replace(".", ",")}
              </span>
            </div>
          </div>

          <div className="cfg-callout">
            <span aria-hidden="true">↔</span>
            <span>
              <b>{people}</b> o <b>{people * 10}</b> persone: il costo motore{" "}
              <b>non cambia</b>. Scala con le lingue, non con le teste — è qui il
              margine.
            </span>
          </div>

          <div className={`cfg-perf ${perf.cls}`}>
            <span className="dot" />
            Banda in uscita ~
            {mbit < 10 ? mbit.toFixed(1) : Math.round(mbit)} Mbit/s · {perf.host}
          </div>
        </section>
      </div>

      <p className="cfg-foot">
        Tariffe di default (gpt-realtime, $0,06/$0,24) da{" "}
        <code>server/src/rooms.ts</code>. I preset mini e pipeline sono stime.
        Numeri di prestazione: ordini di grandezza, non load-test.
      </p>
    </main>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const shown = format
    ? format(value)
    : Number.isInteger(value)
      ? String(value)
      : value.toFixed(step < 1 ? 1 : 0).replace(".", ",");
  return (
    <div className="cfg-ctrl">
      <span className="cfg-label">
        {label}
        <b>
          {shown}
          {unit ? <span className="u"> {unit}</span> : null}
        </b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
