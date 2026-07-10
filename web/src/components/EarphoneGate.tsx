import { useEffect } from "react";
import { strings, eventStrings } from "../lib/i18n";

interface Props {
  /** Lingua del partecipante, per il testo del gate. */
  lang: string;
  /** Auricolari indossati: si può entrare in stanza. */
  onReady: () => void;
  /** Torna all'onboarding. */
  onBack: () => void;
}

/**
 * Gate degli auricolari per la modalità evento. I browser non possono rilevare
 * via hardware se gli auricolari sono indossati, quindi il requisito è
 * un'autodichiarazione: un invito animato + conferma esplicita, prima di
 * entrare. Serve a evitare fischi e disturbi in sala (l'audio tradotto non deve
 * uscire dagli altoparlanti del telefono).
 */
export function EarphoneGate({ lang, onReady, onBack }: Props) {
  const t = strings(lang);
  const ev = eventStrings(lang);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = t.dir;
  }, [lang, t.dir]);

  return (
    <main className="earphone-gate" dir={t.dir}>
      <div className="earphone-animation" aria-hidden="true">
        <span className="earphone-emoji">🎧</span>
        <span className="earphone-wave earphone-wave-1" />
        <span className="earphone-wave earphone-wave-2" />
        <span className="earphone-wave earphone-wave-3" />
      </div>
      <h2>{ev.earphoneTitle}</h2>
      <p className="earphone-body">{ev.earphoneBody}</p>
      <button type="button" className="enter-button" onClick={onReady}>
        {ev.earphoneConfirm}
      </button>
      <button type="button" className="share-close" onClick={onBack}>
        {ev.earphoneBack}
      </button>
    </main>
  );
}
