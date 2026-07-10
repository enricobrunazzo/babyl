import { useState } from "react";
import { useRoom } from "../hooks/useRoom";
import { languageByCode, LANGUAGES } from "../lib/languages";
import type { TranslationTiming } from "../../../shared/protocol";
import type { Profile } from "./Onboarding";
import { MicButton } from "./MicButton";
import { PTTButton } from "./PTTButton";
import { QRCode } from "./QRCode";

/** Preset di tempistica offerti in stanza (condivisi da tutti i partecipanti). */
const TIMING_OPTIONS: { value: TranslationTiming; label: string; hint: string }[] =
  [
    {
      value: "streaming",
      label: "Conversazione (simultanea)",
      hint: "La traduzione parte mentre parli, effetto interprete TV.",
    },
    {
      value: "interview",
      label: "Intervista (frasi intere)",
      hint: "Attende le pause più lunghe: turni netti, niente frasi spezzate.",
    },
    {
      value: "consecutive",
      label: "Consecutiva (al rilascio)",
      hint: "Traduce solo quando rilasci il pulsante: turni puliti.",
    },
  ];

interface Props {
  roomId: string;
  profile: Profile;
  onLeave: () => void;
  /** Crea e passa a una nuova stanza (rimonta il client). */
  onNewRoom: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  idle: "Inizializzazione…",
  mic: "Attivazione microfono…",
  connecting: "Connessione alla stanza…",
  connected: "Connesso",
  reconnecting: "Riconnessione…",
  closed: "Disconnesso",
  error: "Errore di connessione",
};

const DEBUG = new URLSearchParams(location.search).get("debug") === "1";

export function Room({ roomId, profile, onLeave, onNewRoom }: Props) {
  const isSolo = profile.mode === "solo";
  const [showShare, setShowShare] = useState(false);
  const [copied, setCopied] = useState(false);
  const shareUrl = `${location.origin}/?room=${encodeURIComponent(roomId)}`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const nativeShare = async () => {
    try {
      await navigator.share({ title: "babyl", text: "Entra nella stanza", url: shareUrl });
    } catch {
      // Condivisione annullata o non supportata: il pannello resta aperto.
    }
  };
  const { client, state } = useRoom({
    room: roomId,
    nickname: profile.nickname,
    lang: profile.lang,
    debug: DEBUG,
    soloTarget: isSolo ? profile.langB : undefined,
  });

  if (state.error === "mic-denied") {
    return (
      <main className="room room-error">
        <h2>Microfono non disponibile</h2>
        <p>
          Babyl ha bisogno del microfono per la traduzione in tempo reale.
          Consenti l'accesso dalle impostazioni del browser e riprova.
        </p>
        <button type="button" className="enter-button" onClick={onLeave}>
          Torna all'inizio
        </button>
      </main>
    );
  }

  const participants = state.self ? [state.self, ...state.peers] : state.peers;
  const pttState = client.pttState();
  const connected = state.status === "connected";
  const speaker = participants.find((p) => p.id === state.subtitle?.speakerId);
  const selfLanguage = languageByCode(state.self?.lang ?? "");
  const timing = TIMING_OPTIONS.find((t) => t.value === state.translation.timing);

  return (
    <main className="room" data-audio-frames={state.audioFramesReceived}>
      <header className="room-header">
        <div>
          <h2>{isSolo ? "Un solo dispositivo" : roomId}</h2>
          <p className={`status status-${state.status}`}>
            {STATUS_LABELS[state.status]}
            {connected && ` · ${participants.length} partecipant${participants.length === 1 ? "e" : "i"}`}
          </p>
          {connected && (
            <p
              className={`translation-badge ${state.translation.enabled ? "on" : "off"}`}
            >
              {state.translation.enabled
                ? "Traduzione simultanea attiva"
                : "Voce originale (traduzione non configurata)"}
            </p>
          )}
          {connected && !isSolo && selfLanguage && (
            <p className="language-badge">
              Ascolti in: {selfLanguage.flag} {selfLanguage.nativeName}
            </p>
          )}
          {connected && !isSolo && state.self && (
            <label className="field-inline">
              <span>Lingua di ascolto</span>
              <select
                value={state.self.lang}
                onChange={(e) => client.updateLanguage(e.target.value)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.flag} {l.nativeName}
                  </option>
                ))}
              </select>
            </label>
          )}
          {connected && !isSolo && state.translation.enabled && (
            <label className="field-inline">
              <span>Tempistica</span>
              <select
                value={state.translation.timing}
                onChange={(e) =>
                  client.setTiming(e.target.value as TranslationTiming)
                }
              >
                {TIMING_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              {timing && <small className="field-help">{timing.hint}</small>}
            </label>
          )}
        </div>
        <div className="header-actions">
          {!isSolo && (
            <button
              type="button"
              className="share-button"
              onClick={() => setShowShare(true)}
            >
              Condividi
            </button>
          )}
          <button type="button" className="leave-button" onClick={onLeave}>
            Esci
          </button>
        </div>
      </header>

      {showShare && !isSolo && (
        <div
          className="share-overlay"
          role="dialog"
          aria-label="Condividi la stanza"
          onClick={() => setShowShare(false)}
        >
          <div className="share-panel" onClick={(e) => e.stopPropagation()}>
            <h3>Invita nella stanza</h3>
            <p className="share-hint">
              Inquadra il QR o condividi il link: chi entra è subito in stanza,
              senza installare nulla.
            </p>
            <QRCode text={shareUrl} />
            <code className="share-url">{shareUrl}</code>
            <div className="share-actions">
              <button type="button" className="enter-button" onClick={copyLink}>
                {copied ? "Copiato ✓" : "Copia link"}
              </button>
              {typeof navigator.share === "function" && (
                <button
                  type="button"
                  className="share-button"
                  onClick={nativeShare}
                >
                  Condividi…
                </button>
              )}
            </div>
            <button
              type="button"
              className="share-new-room"
              onClick={() => {
                setShowShare(false);
                onNewRoom();
              }}
            >
              + Crea nuova stanza
            </button>
            <button
              type="button"
              className="share-close"
              onClick={() => setShowShare(false)}
            >
              Chiudi
            </button>
          </div>
        </div>
      )}

      {!isSolo && (
      <ul className="participants">
        {participants.map((peer) => {
          const lang = languageByCode(peer.lang);
          const speaking = state.channel.speakerId === peer.id;
          return (
            <li
              key={peer.id}
              className={`participant${speaking ? " speaking" : ""}`}
            >
              <span className="participant-flag" aria-hidden="true">
                {lang?.flag ?? "🌐"}
              </span>
              <span className="participant-name">
                {peer.nickname}
                {peer.id === state.self?.id && " (tu)"}
              </span>
              {lang && (
                <span className="participant-lang">
                  {lang.flag} {lang.nativeName}
                </span>
              )}
              {speaking && <span className="speaking-dot" aria-hidden="true" />}
            </li>
          );
        })}
      </ul>
      )}

      {state.subtitle && state.subtitle.text && (
        <div className="subtitle" role="log" aria-live="polite">
          {speaker && <span className="subtitle-speaker">{speaker.nickname}</span>}
          <p>{state.subtitle.text}</p>
        </div>
      )}

      {state.translationError && (
        <div className="translation-error" role="status">
          Traduzione temporaneamente non disponibile (motore sovraccarico).
          Riprova tra qualche secondo.
        </div>
      )}

      {DEBUG && (
        <dl className="debug-panel" aria-label="Metriche diagnostiche">
          <div>
            <dt>Banda ↑</dt>
            <dd>{state.metrics.upKbps} kbit/s</dd>
          </div>
          <div>
            <dt>Banda ↓</dt>
            <dd>{state.metrics.downKbps} kbit/s</dd>
          </div>
          <div>
            <dt>Latenza</dt>
            <dd>
              {state.metrics.lastLatencyMs !== null
                ? `${state.metrics.lastLatencyMs} ms`
                : "—"}
            </dd>
          </div>
          <div>
            <dt>Jitter buffer</dt>
            <dd>{state.metrics.jitterMs} ms</dd>
          </div>
          <div>
            <dt>Frame ricevuti</dt>
            <dd>{state.metrics.framesReceived}</dd>
          </div>
          <div>
            <dt>Totale ↑ / ↓</dt>
            <dd>
              {(state.metrics.upBytes / 1024).toFixed(0)} /{" "}
              {(state.metrics.downBytes / 1024).toFixed(0)} KB
            </dd>
          </div>
        </dl>
      )}

      {isSolo && state.solo ? (
        <div className="solo-mics">
          <div className="solo-mics-row">
            {[profile.lang, profile.langB]
              .filter((c): c is string => Boolean(c))
              .map((code) => {
                const lang = languageByCode(code);
                const recording =
                  pttState === "talking" && state.solo?.source === code;
                const otherTalking =
                  pttState === "talking" && state.solo?.source !== code;
                return (
                  <MicButton
                    key={code}
                    flag={lang?.flag ?? "🌐"}
                    name={lang?.nativeName ?? code}
                    recording={recording}
                    disabled={!connected || otherTalking}
                    onPress={() => {
                      client.setSoloSource(code);
                      client.pttDown();
                    }}
                    onRelease={() => client.pttUp()}
                  />
                );
              })}
          </div>
          <p className="ptt-label" role="status">
            Tieni premuto il microfono della lingua di chi parla
          </p>
        </div>
      ) : (
        <PTTButton
          state={pttState}
          speakerName={state.channel.speakerName}
          disabled={!connected}
          onPress={() => client.pttDown()}
          onRelease={() => client.pttUp()}
        />
      )}
    </main>
  );
}
