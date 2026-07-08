import { useState } from "react";
import { detectLanguage, LANGUAGES } from "../lib/languages";

export interface Profile {
  nickname: string;
  lang: string;
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
  const [lang, setLang] = useState(detectLanguage());
  const [nickname, setNickname] = useState("");
  const [consent, setConsent] = useState(false);

  const canEnter = nickname.trim().length > 0 && consent;

  return (
    <main className="onboarding">
      <header className="brand">
        <h1>babyl</h1>
        <p>Traduzione simultanea. Zero download, zero account.</p>
      </header>

      <form
        className="onboarding-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canEnter) onEnter({ nickname: nickname.trim(), lang });
        }}
      >
        <label className="field">
          <span>La tua lingua</span>
          <select
            value={lang}
            onChange={(event) => setLang(event.target.value)}
            aria-label="Seleziona la tua lingua"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.flag} {l.nativeName}
              </option>
            ))}
          </select>
        </label>

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
        Stanza: <strong>{roomId}</strong>
      </footer>
    </main>
  );
}
