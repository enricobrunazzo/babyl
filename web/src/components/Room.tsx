import { useRoom } from "../hooks/useRoom";
import { languageByCode, LANGUAGES } from "../lib/languages";
import type { TranslationTiming } from "../../../shared/protocol";
import type { Profile } from "./Onboarding";
import { PTTButton } from "./PTTButton";

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

export function Room({ roomId, profile, onLeave }: Props) {
  const isSolo = profile.mode === "solo";
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
        <button type="button" className="leave-button" onClick={onLeave}>
          Esci
        </button>
      </header>

      {isSolo && state.solo ? (
        <div className="solo-control">
          {(() => {
            const src = languageByCode(state.solo.source);
            const tgt = languageByCode(state.solo.target);
            return (
              <>
                <p className="solo-direction">
                  <span className="solo-side speaking">
                    {src?.flag} {src?.nativeName ?? state.solo.source}
                  </span>
                  <span className="solo-arrow" aria-hidden="true">→</span>
                  <span className="solo-side">
                    {tgt?.flag} {tgt?.nativeName ?? state.solo.target}
                  </span>
                </p>
                <small className="field-help">
                  Chi parla ora usa la lingua a sinistra; la traduzione esce al
                  rilascio del pulsante.
                </small>
                <button
                  type="button"
                  className="solo-swap"
                  onClick={() => client.toggleSolo()}
                  disabled={pttState === "talking"}
                >
                  ⇄ Inverti i lati
                </button>
              </>
            );
          })()}
        </div>
      ) : (
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

      <PTTButton
        state={pttState}
        speakerName={state.channel.speakerName}
        disabled={!connected}
        onPress={() => client.pttDown()}
        onRelease={() => client.pttUp()}
      />
    </main>
  );
}
