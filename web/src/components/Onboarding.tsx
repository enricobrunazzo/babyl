import { useState } from "react";
import { detectLanguage, LANGUAGES } from "../lib/languages";
import { BabylMark } from "./BabylLogo";

export interface Profile {
  nickname: string;
  /** Modalità stanza: lingua d'ascolto. Single-device: prima lingua (lato A). */
  lang: string;
  /** "room" (default, multi-dispositivo) oppure "solo" (single-device). */
  mode: "room" | "solo";
  /** Solo single-device: seconda lingua (lato B). */
  langB?: string;
}

/** Prima lingua diversa da `lang`, come default sensato per il lato B. */
function otherLang(lang: string): string {
  return (LANGUAGES.find((l) => l.code !== lang) ?? LANGUAGES[0]).code;
}

interface Props {
  roomId: string;
  onEnter: (profile: Profile) => void;
}

/**
 * Onboarding invisibile (§2.1): lingua auto-compilata da navigator.language
 * con menu a tendina minimale per l'override, nickname a singolo tap
 * (autocomplete="given-name"), consenso esplicito e un unico pulsante ENTRA.
 * Nessun dato viene scritto in localStorage: il sistema è stateless.
 */
export function Onboarding({ roomId, onEnter }: Props) {
  const [mode, setMode] = useState<"room" | "solo">("room");
  const [lang, setLang] = useState(detectLanguage());
  const [langB, setLangB] = useState(() => otherLang(detectLanguage()));
  const [nickname, setNickname] = useState("");
  const [consent, setConsent] = useState(false);

  const solo = mode === "solo";
  const langsDiffer = lang !== langB;
  const canEnter =
    consent &&
    (solo ? langsDiffer : nickname.trim().length > 0);

  return (
    <main className="onboarding">
      <header className="brand">
        <BabylMark size={64} className="brand-mark" />
        <h1>babyl</h1>
        <p>Traduzione simultanea. Zero download, zero account.</p>
      </header>

      <form
        className="onboarding-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canEnter) return;
          onEnter({
            nickname: nickname.trim() || (solo ? "Dispositivo" : ""),
            lang,
            mode,
            langB: solo ? langB : undefined,
          });
        }}
      >
        <div className="mode-switch" role="group" aria-label="Modalità">
          <button
            type="button"
            className={`mode-option${solo ? "" : " active"}`}
            aria-pressed={!solo}
            onClick={() => setMode("room")}
          >
            In stanza
          </button>
          <button
            type="button"
            className={`mode-option${solo ? " active" : ""}`}
            aria-pressed={solo}
            onClick={() => setMode("solo")}
          >
            Un solo dispositivo
          </button>
        </div>
        <label className="field">
          <span>{solo ? "Lingua A (prima persona)" : "Lingua in cui vuoi ascoltare"}</span>
          <small className="field-help">
            {solo
              ? "Una delle due lingue parlate al dispositivo."
              : "Babyl tradurrà gli altri partecipanti in questa lingua."}
          </small>
          <select
            value={lang}
            onChange={(event) => setLang(event.target.value)}
            aria-label="Seleziona la prima lingua"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.flag} {l.nativeName}
              </option>
            ))}
          </select>
        </label>

        {solo && (
          <label className="field">
            <span>Lingua B (seconda persona)</span>
            <small className="field-help">
              L'altra lingua: il dispositivo traduce tra le due a ogni turno.
            </small>
            <select
              value={langB}
              onChange={(event) => setLangB(event.target.value)}
              aria-label="Seleziona la seconda lingua"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.flag} {l.nativeName}
                </option>
              ))}
            </select>
            {!langsDiffer && (
              <small className="field-error">
                Le due lingue devono essere diverse.
              </small>
            )}
          </label>
        )}

        {!solo && (
          <label className="field">
            <span>Il tuo nome</span>
            <input
              type="text"
              name="nickname"
              autoComplete="given-name"
              autoFocus
              maxLength={40}
              placeholder="Come ti chiami?"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
            />
          </label>
        )}

        <label className="consent">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />
          <span>Dichiaro di avere più di 16 anni o il consenso dei genitori.</span>
        </label>

        <button type="submit" className="enter-button" disabled={!canEnter}>
          ENTRA
        </button>

        <p className="disclaimer">
          Cliccando su ENTRA, accetti i Termini di Servizio e acconsenti
          all'elaborazione temporanea dell'audio per la traduzione in tempo
          reale.
        </p>
      </form>

      <footer className="room-hint">
        {solo ? (
          <>Un telefono, due persone: parla a turno, tocca ⇄ per invertire.</>
        ) : (
          <>
            Stanza: <strong>{roomId}</strong>
          </>
        )}
      </footer>
    </main>
  );
}
