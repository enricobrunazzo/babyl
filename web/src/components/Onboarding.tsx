import { useEffect, useState } from "react";
import { detectLanguage, languageByCode, LANGUAGES } from "../lib/languages";
import { strings, eventStrings } from "../lib/i18n";
import { newRoomId } from "../lib/roomName";
import { BabylMark } from "./BabylLogo";
import type { PeerRole } from "../../../shared/protocol";

export interface Profile {
  nickname: string;
  /** Modalità stanza: lingua d'ascolto. Single-device: prima lingua (lato A). */
  lang: string;
  /** "room" (multi-dispositivo), "solo" (single-device) o "event" (conferenza). */
  mode: "room" | "solo" | "event";
  /** Solo single-device: seconda lingua (lato B). */
  langB?: string;
  /** Evento: "speaker" (relatore) o "audience" (pubblico). */
  role?: PeerRole;
}

/** Prima lingua diversa da `lang`, come default sensato per il lato B. */
function otherLang(lang: string): string {
  return (LANGUAGES.find((l) => l.code !== lang) ?? LANGUAGES[0]).code;
}

/**
 * Ripristino del form dopo un refresh accidentale: nome e lingue vivono in
 * sessionStorage (per-scheda, sparisce alla chiusura — come il banner PWA),
 * coerente col vincolo stateless "niente localStorage, nessun account".
 */
const RESTORE_NICKNAME = "babyl:nickname";
const RESTORE_LANG = "babyl:lang";
const RESTORE_LANG_B = "babyl:langB";

function restore(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function persist(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Storage non disponibile (privacy mode): il form riparte vuoto, pazienza.
  }
}

/** Lingua salvata se ancora valida, altrimenti quella rilevata dal browser. */
function restoreLang(key: string, fallback: () => string): string {
  const saved = restore(key);
  return saved && languageByCode(saved) ? saved : fallback();
}

interface Props {
  roomId: string;
  /** Il link portava `?event=1`: l'utente entra come pubblico di un evento. */
  eventJoin: boolean;
  onRoomChange: (id: string) => void;
  onEnter: (profile: Profile) => void;
}

/**
 * Onboarding invisibile (§2.1): lingua auto-compilata da navigator.language
 * con menu a tendina minimale per l'override, nickname a singolo tap
 * (autocomplete="given-name"), consenso esplicito e un unico pulsante ENTRA.
 * Nessun dato viene scritto in localStorage: il sistema è stateless. Nome e
 * lingue vivono solo in sessionStorage (per-scheda) per sopravvivere a un
 * refresh accidentale, come già il banner PWA.
 *
 * Modalità evento: chi apre il link con `?event=1` entra come pubblico
 * (ascolto puro); il relatore crea l'evento scegliendo la scheda "Evento".
 */
export function Onboarding({ roomId, eventJoin, onRoomChange, onEnter }: Props) {
  const [mode, setMode] = useState<"room" | "solo" | "event">("room");
  const [lang, setLang] = useState(() => restoreLang(RESTORE_LANG, detectLanguage));
  const [langB, setLangB] = useState(() =>
    restoreLang(RESTORE_LANG_B, () => otherLang(detectLanguage())),
  );
  const [nickname, setNickname] = useState(() => restore(RESTORE_NICKNAME) ?? "");
  const [consent, setConsent] = useState(false);

  // Salva nome e lingue alla conferma, così un refresh in stanza non obbliga
  // a ricompilare il form (il consenso invece si richiede ogni volta).
  const persistProfile = (profile: Profile) => {
    persist(RESTORE_NICKNAME, profile.nickname);
    persist(RESTORE_LANG, profile.lang);
    if (profile.langB) persist(RESTORE_LANG_B, profile.langB);
  };

  // L'interfaccia segue la lingua scelta: chi seleziona "English" vede
  // l'onboarding in inglese, e così via. La direzione del testo (RTL per
  // l'arabo) è applicata all'intero documento.
  const t = strings(lang);
  const ev = eventStrings(lang);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = t.dir;
  }, [lang, t.dir]);

  const solo = mode === "solo";
  const event = mode === "event";
  const langsDiffer = lang !== langB;

  // Selettore di lingua riutilizzato in più punti.
  const langSelect = (
    value: string,
    onChange: (v: string) => void,
    ariaLabel: string,
  ) => (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
    >
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.flag} {l.nativeName}
        </option>
      ))}
    </select>
  );

  const consentField = (
    <label className="consent">
      <input
        type="checkbox"
        checked={consent}
        onChange={(e) => setConsent(e.target.checked)}
      />
      <span>{t.consent}</span>
    </label>
  );

  // --- Pubblico di un evento (link con ?event=1) ---
  if (eventJoin) {
    const enterAudience = () => {
      if (!consent) return;
      const profile: Profile = {
        nickname: nickname.trim() || ev.roleAudience,
        lang,
        mode: "event",
        role: "audience",
      };
      persistProfile(profile);
      onEnter(profile);
    };
    return (
      <main className="onboarding" dir={t.dir}>
        <header className="brand">
          <BabylMark size={64} className="brand-mark" />
          <h1>babyl</h1>
          <p>{ev.audienceJoinHint}</p>
        </header>
        <form
          className="onboarding-form"
          onSubmit={(e) => {
            e.preventDefault();
            enterAudience();
          }}
        >
          <p className="event-role-badge">🎤 {ev.audienceJoinTitle}</p>
          <label className="field">
            <span>{t.listenLangLabel}</span>
            <small className="field-help">{t.listenLangHelp}</small>
            {langSelect(lang, setLang, t.selectFirstLang)}
          </label>
          <label className="field">
            <span>{t.nameLabel}</span>
            <input
              type="text"
              name="nickname"
              autoComplete="given-name"
              maxLength={40}
              placeholder={t.namePlaceholder}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
            />
          </label>
          {consentField}
          <button type="submit" className="enter-button" disabled={!consent}>
            {t.enter}
          </button>
          <p className="disclaimer">{t.disclaimer}</p>
        </form>
      </main>
    );
  }

  const canEnter =
    consent &&
    (solo ? langsDiffer : nickname.trim().length > 0);

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
          const profile: Profile = {
            nickname: nickname.trim() || (solo ? t.deviceName : ""),
            lang,
            mode,
            langB: solo ? langB : undefined,
            role: mode === "event" ? "speaker" : undefined,
          };
          persistProfile(profile);
          onEnter(profile);
        }}
      >
        <div className="mode-switch" role="group" aria-label={t.modeGroupLabel}>
          <button
            type="button"
            className={`mode-option${mode === "room" ? " active" : ""}`}
            aria-pressed={mode === "room"}
            onClick={() => setMode("room")}
          >
            {t.modeRoom}
          </button>
          <button
            type="button"
            className={`mode-option${mode === "solo" ? " active" : ""}`}
            aria-pressed={mode === "solo"}
            onClick={() => setMode("solo")}
          >
            {t.modeSolo}
          </button>
          <button
            type="button"
            className={`mode-option${mode === "event" ? " active" : ""}`}
            aria-pressed={mode === "event"}
            onClick={() => setMode("event")}
          >
            {ev.modeEvent}
          </button>
        </div>

        {event && <p className="field-help event-hint">{ev.eventCreateHint}</p>}

        <label className="field">
          <span>{solo ? t.langAlabel : t.listenLangLabel}</span>
          <small className="field-help">
            {solo ? t.langAhelp : t.listenLangHelp}
          </small>
          {langSelect(lang, setLang, t.selectFirstLang)}
        </label>

        {solo && (
          <label className="field">
            <span>{t.langBlabel}</span>
            <small className="field-help">{t.langBhelp}</small>
            {langSelect(langB, setLangB, t.selectSecondLang)}
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

        {consentField}

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
