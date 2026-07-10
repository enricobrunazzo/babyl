import { useEffect, useState } from "react";
import { detectLanguage, LANGUAGES } from "../lib/languages";
import { strings } from "../lib/i18n";
import { newRoomId } from "../lib/roomName";
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
  onRoomChange: (id: string) => void;
  onEnter: (profile: Profile) => void;
}

/**
 * Onboarding invisibile (§2.1): lingua auto-compilata da navigator.language
 * con menu a tendina minimale per l'override, nickname a singolo tap
 * (autocomplete="given-name"), consenso esplicito e un unico pulsante ENTRA.
 * Nessun dato viene scritto in localStorage: il sistema è stateless.
 */
export function Onboarding({ roomId, onRoomChange, onEnter }: Props) {
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

  // L'interfaccia segue la lingua scelta: chi seleziona "English" vede
  // l'onboarding in inglese, e così via. La direzione del testo (RTL per
  // l'arabo) è applicata all'intero documento.
  const t = strings(lang);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = t.dir;
  }, [lang, t.dir]);

  return (
    <main className="onboarding" dir={t.dir}>
      <header className="brand">
        <BabylMark size={64} className="brand-mark" />
        <h1>babyl</h1>
        <p>{t.tagline}</p>
      </header>

      <form
        className="onboarding-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canEnter) return;
          onEnter({
            nickname: nickname.trim() || (solo ? t.deviceName : ""),
            lang,
            mode,
            langB: solo ? langB : undefined,
          });
        }}
      >
        <div className="mode-switch" role="group" aria-label={t.modeGroupLabel}>
          <button
            type="button"
            className={`mode-option${solo ? "" : " active"}`}
            aria-pressed={!solo}
            onClick={() => setMode("room")}
          >
            {t.modeRoom}
          </button>
          <button
            type="button"
            className={`mode-option${solo ? " active" : ""}`}
            aria-pressed={solo}
            onClick={() => setMode("solo")}
          >
            {t.modeSolo}
          </button>
        </div>
        <label className="field">
          <span>{solo ? t.langAlabel : t.listenLangLabel}</span>
          <small className="field-help">
            {solo ? t.langAhelp : t.listenLangHelp}
          </small>
          <select
            value={lang}
            onChange={(event) => setLang(event.target.value)}
            aria-label={t.selectFirstLang}
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
            <span>{t.langBlabel}</span>
            <small className="field-help">{t.langBhelp}</small>
            <select
              value={langB}
              onChange={(event) => setLangB(event.target.value)}
              aria-label={t.selectSecondLang}
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.flag} {l.nativeName}
                </option>
              ))}
            </select>
            {!langsDiffer && (
              <small className="field-error">{t.langsMustDiffer}</small>
            )}
          </label>
        )}

        {!solo && (
          <label className="field">
            <span>{t.nameLabel}</span>
            <input
              type="text"
              name="nickname"
              autoComplete="given-name"
              autoFocus
              maxLength={40}
              placeholder={t.namePlaceholder}
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
          <span>{t.consent}</span>
        </label>

        {!solo && (
          <label className="field">
            <span>{t.roomLabel}</span>
            <small className="field-help">{t.roomHelp}</small>
            <div className="room-field">
              <input
                type="text"
                value={roomId}
                maxLength={64}
                onChange={(event) => onRoomChange(event.target.value)}
                aria-label={t.roomAria}
              />
              <button
                type="button"
                className="room-generate"
                onClick={() => onRoomChange(newRoomId())}
              >
                {t.generate}
              </button>
            </div>
          </label>
        )}

        <button type="submit" className="enter-button" disabled={!canEnter}>
          {t.enter}
        </button>

        <p className="disclaimer">{t.disclaimer}</p>
      </form>

      {solo && <footer className="room-hint">{t.soloHint}</footer>}
    </main>
  );
}
