import { useEffect, useState } from "react";
import { useRoom } from "../hooks/useRoom";
import { languageByCode, LANGUAGES } from "../lib/languages";
import { strings, eventStrings, type UIStrings } from "../lib/i18n";
import type { TranslationTiming } from "../../../shared/protocol";
import type { Profile } from "./Onboarding";
import { MicButton } from "./MicButton";
import { PTTButton } from "./PTTButton";
import { QRCode } from "./QRCode";

/** Preset di tempistica offerti in stanza (condivisi da tutti i partecipanti). */
function timingOptions(
  t: UIStrings,
): { value: TranslationTiming; label: string; hint: string }[] {
  return [
    {
      value: "streaming",
      label: t.timingStreamingLabel,
      hint: t.timingStreamingHint,
    },
    {
      value: "interview",
      label: t.timingInterviewLabel,
      hint: t.timingInterviewHint,
    },
    {
      value: "consecutive",
      label: t.timingConsecutiveLabel,
      hint: t.timingConsecutiveHint,
    },
  ];
}

interface Props {
  roomId: string;
  profile: Profile;
  onLeave: () => void;
  /** Crea e passa a una nuova stanza (rimonta il client). */
  onNewRoom: () => void;
}

function statusLabel(t: UIStrings, status: string): string {
  const labels: Record<string, string> = {
    idle: t.statusIdle,
    mic: t.statusMic,
    connecting: t.statusConnecting,
    connected: t.statusConnected,
    reconnecting: t.statusReconnecting,
    closed: t.statusClosed,
    error: t.statusError,
  };
  return labels[status] ?? status;
}

const DEBUG = new URLSearchParams(location.search).get("debug") === "1";

export function Room({ roomId, profile, onLeave, onNewRoom }: Props) {
  const isSolo = profile.mode === "solo";
  const isEvent = profile.mode === "event";
  const [showShare, setShowShare] = useState(false);
  const [copied, setCopied] = useState(false);
  // Il link di un evento porta ?event=1: chi lo apre entra come pubblico.
  const shareUrl = `${location.origin}/?room=${encodeURIComponent(roomId)}${
    isEvent ? "&event=1" : ""
  }`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const { client, state } = useRoom({
    room: roomId,
    nickname: profile.nickname,
    lang: profile.lang,
    debug: DEBUG,
    soloTarget: isSolo ? profile.langB : undefined,
    mode: isEvent ? "event" : undefined,
    role: isEvent ? profile.role : undefined,
  });

  // L'interfaccia della stanza segue la lingua d'ascolto del partecipante:
  // chi ascolta in inglese vede la stanza in inglese. In stanza la lingua può
  // cambiare a caldo (selettore "Lingua di ascolto"), quindi seguiamo
  // state.self.lang con fallback al profilo iniziale.
  const uiLang = state.self?.lang ?? profile.lang;
  const t = strings(uiLang);
  const ev = eventStrings(uiLang);
  useEffect(() => {
    document.documentElement.lang = uiLang;
    document.documentElement.dir = t.dir;
  }, [uiLang, t.dir]);

  const nativeShare = async () => {
    try {
      await navigator.share({ title: "babyl", text: t.shareText, url: shareUrl });
    } catch {
      // Condivisione annullata o non supportata: il pannello resta aperto.
    }
  };

  if (state.error === "mic-denied") {
    return (
      <main className="room room-error" dir={t.dir}>
        <h2>{t.micDeniedTitle}</h2>
        <p>{t.micDeniedBody}</p>
        <button type="button" className="enter-button" onClick={onLeave}>
          {t.backToStart}
        </button>
      </main>
    );
  }

  const participants = state.self ? [state.self, ...state.peers] : state.peers;
  const pttState = client.pttState();
  const connected = state.status === "connected";
  const speaker = participants.find((p) => p.id === state.subtitle?.speakerId);
  const selfLanguage = languageByCode(state.self?.lang ?? "");
  const timingList = timingOptions(t);
  const timing = timingList.find((o) => o.value === state.translation.timing);
  // L'annullamento del PTT è efficace solo quando nulla è ancora stato tradotto
  // al rilascio: in consecutiva (sempre in single-device). In streaming/intervista
  // il VAD ha già emesso i segmenti, quindi non si offre il gesto (fuorviante).
  const pttCancelable =
    state.translation.enabled && state.translation.timing === "consecutive";

  // Modalità evento: ruolo e stato della parola (Q&A).
  const role = state.role;
  const isSpeaker = isEvent && role === "speaker";
  const isAudience = isEvent && role === "audience";
  const hasFloor = state.floor != null && state.floor === state.self?.id;
  const handRaised = state.self ? state.hands.includes(state.self.id) : false;
  const floorHolder = participants.find((p) => p.id === state.floor);
  const handsPeers = state.hands
    .map((id) => participants.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

  // Il pubblico senza la parola non ha il pulsante PTT: alza la mano.
  const audienceWaiting = isAudience && !hasFloor;

  return (
    <main className="room" dir={t.dir} data-audio-frames={state.audioFramesReceived}>
      <header className="room-header">
        <div>
          <h2>{isSolo ? t.soloTitle : isEvent ? `${ev.eventTitle} · ${roomId}` : roomId}</h2>
          <p className={`status status-${state.status}`}>
            {statusLabel(t, state.status)}
            {connected && ` · ${t.participantCount(participants.length)}`}
          </p>
          {connected && isEvent && (
            <p className={`event-role-badge ${isSpeaker ? "speaker" : "audience"}`}>
              {isSpeaker ? `🎤 ${ev.badgeSpeaker}` : `🎧 ${ev.badgeAudience}`}
            </p>
          )}
          {connected && (
            <p
              className={`translation-badge ${state.translation.enabled ? "on" : "off"}`}
            >
              {state.translation.enabled ? t.translationOn : t.translationOff}
            </p>
          )}
          {connected && !isSolo && selfLanguage && (
            <p className="language-badge">
              {t.listeningIn} {selfLanguage.flag} {selfLanguage.nativeName}
            </p>
          )}
          {connected && !isSolo && state.self && (
            <label className="field-inline">
              <span>{t.listenLangInline}</span>
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
          {connected && !isSolo && !isAudience && state.translation.enabled && (
            <label className="field-inline">
              <span>{t.timingInline}</span>
              <select
                value={state.translation.timing}
                onChange={(e) =>
                  client.setTiming(e.target.value as TranslationTiming)
                }
              >
                {timingList.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {timing && <small className="field-help">{timing.hint}</small>}
            </label>
          )}
        </div>
        <div className="header-actions">
          {!isSolo && !isAudience && (
            <button
              type="button"
              className="share-button"
              onClick={() => setShowShare(true)}
            >
              {t.share}
            </button>
          )}
          <button type="button" className="leave-button" onClick={onLeave}>
            {t.leave}
          </button>
        </div>
      </header>

      {showShare && !isSolo && (
        <div
          className="share-overlay"
          role="dialog"
          aria-label={t.shareAria}
          onClick={() => setShowShare(false)}
        >
          <div className="share-panel" onClick={(e) => e.stopPropagation()}>
            <h3>{t.inviteTitle}</h3>
            <p className="share-hint">{isEvent ? ev.eventShareHint : t.inviteHint}</p>
            <QRCode text={shareUrl} />
            <code className="share-url">{shareUrl}</code>
            <div className="share-actions">
              <button type="button" className="enter-button" onClick={copyLink}>
                {copied ? t.copied : t.copyLink}
              </button>
              {typeof navigator.share === "function" && (
                <button
                  type="button"
                  className="share-button"
                  onClick={nativeShare}
                >
                  {t.shareEllipsis}
                </button>
              )}
            </div>
            {!isEvent && (
              <button
                type="button"
                className="share-new-room"
                onClick={() => {
                  setShowShare(false);
                  onNewRoom();
                }}
              >
                {t.newRoom}
              </button>
            )}
            <button
              type="button"
              className="share-close"
              onClick={() => setShowShare(false)}
            >
              {t.close}
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
                {peer.id === state.self?.id && ` ${t.you}`}
                {peer.role === "speaker" && isEvent && " 🎤"}
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

      {/* Evento · relatore: coda delle richieste di intervento (Q&A). */}
      {isSpeaker && (
        <section className="hands-queue" aria-label={ev.handsQueueTitle}>
          <h3>{ev.handsQueueTitle}</h3>
          {floorHolder && (
            <div className="floor-active">
              <span>{ev.floorActiveWith(floorHolder.nickname)}</span>
              <button
                type="button"
                className="revoke-floor"
                onClick={() => client.revokeFloor()}
              >
                {ev.revokeFloor}
              </button>
            </div>
          )}
          {handsPeers.length === 0 ? (
            <p className="no-hands">{ev.noHands}</p>
          ) : (
            <ul className="hands-list">
              {handsPeers.map((peer) => {
                const lang = languageByCode(peer.lang);
                return (
                  <li key={peer.id}>
                    <span className="participant-flag" aria-hidden="true">
                      {lang?.flag ?? "🌐"}
                    </span>
                    <span className="participant-name">✋ {peer.nickname}</span>
                    <button
                      type="button"
                      className="grant-floor"
                      onClick={() => client.grantFloor(peer.id)}
                    >
                      {ev.grantFloor}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* Evento · pubblico in attesa: alza la mano (nessun microfono). */}
      {audienceWaiting ? (
        <div className="audience-controls">
          <p className="audience-hint" role="status">
            {handRaised ? ev.handRaised : ev.audienceListenHint}
          </p>
          <button
            type="button"
            className={`raise-hand${handRaised ? " raised" : ""}`}
            disabled={!connected}
            onClick={() => client.raiseHand(!handRaised)}
          >
            {handRaised ? ev.lowerHand : ev.raiseHand}
          </button>
        </div>
      ) : isSolo && state.solo ? (
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
                    holdLabel={t.micHold(lang?.nativeName ?? code)}
                    cancelLabel={t.cancel}
                    recording={recording}
                    disabled={!connected || otherTalking}
                    onPress={() => {
                      client.setSoloSource(code);
                      client.pttDown();
                    }}
                    onRelease={() => client.pttUp()}
                    onCancel={() => client.pttCancel()}
                  />
                );
              })}
          </div>
          <p className="ptt-label" role="status">
            {pttState === "talking" ? t.cancelHint : t.soloPttHint}
          </p>
        </div>
      ) : (
        <>
          {hasFloor && (
            <p className="mic-enabled-notice" role="status">
              🎙️ {ev.micEnabledNotice}
            </p>
          )}
          {isAudience && state.micGrantDenied && (
            <p className="translation-error" role="status">
              {ev.micGrantDenied}
            </p>
          )}
          <PTTButton
            state={pttState}
            speakerName={state.channel.speakerName}
            disabled={!connected || (isAudience && !hasFloor)}
            labels={{
              free: t.pttFree,
              talking: t.pttTalking,
              blocked: t.pttBlocked,
              speaking: t.pttSpeaking,
              cancelHint: t.cancelHint,
            }}
            onPress={() => client.pttDown()}
            onRelease={() => client.pttUp()}
            onCancel={pttCancelable ? () => client.pttCancel() : undefined}
          />
        </>
      )}

      {state.pttDenied && (
        <p className="ptt-denied-toast" role="status">
          {state.pttDenied === "not-granted" ? ev.audienceListenHint : t.pttBlocked}
        </p>
      )}

      {/* Il canale è tornato libero ma la coda tradotta sta ancora uscendo:
          senza avviso due persone finirebbero per parlare sopra la voce. */}
      {!isSolo && state.playing && state.channel.speakerId === null && (
        <p className="translation-playing" role="status">
          🔊 {t.translationPlaying}
        </p>
      )}

      {state.playing && (
        <button
          type="button"
          className="interrupt-button"
          onClick={() => client.interruptTranslation()}
        >
          ⏹ {t.interrupt}
        </button>
      )}

      {state.translationError && (
        <div className="translation-error" role="status">
          {t.translationError}
        </div>
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
            <dt>{t.debugUp}</dt>
            <dd>{state.metrics.upKbps} kbit/s</dd>
          </div>
          <div>
            <dt>{t.debugDown}</dt>
            <dd>{state.metrics.downKbps} kbit/s</dd>
          </div>
          <div>
            <dt>{t.debugLatency}</dt>
            <dd>
              {state.metrics.lastLatencyMs !== null
                ? `${state.metrics.lastLatencyMs} ms`
                : "—"}
            </dd>
          </div>
          <div>
            <dt>{t.debugJitter}</dt>
            <dd>{state.metrics.jitterMs} ms</dd>
          </div>
          <div>
            <dt>{t.debugFrames}</dt>
            <dd>{state.metrics.framesReceived}</dd>
          </div>
          <div>
            <dt>{t.debugTotal}</dt>
            <dd>
              {(state.metrics.upBytes / 1024).toFixed(0)} /{" "}
              {(state.metrics.downBytes / 1024).toFixed(0)} KB
            </dd>
          </div>
        </dl>
      )}
    </main>
  );
}
