import { useEffect } from "react";
import type { PttState } from "../lib/roomClient";
import { useHoldToTalk } from "../lib/holdToTalk";
import { LockIcon, MicIcon } from "./icons";

export interface PttLabels {
  free: string;
  talking: string;
  blocked: string;
  /** Costruisce l'etichetta «Nome» sta parlando… nella lingua attiva. */
  speaking: (name: string) => string;
  /** Suggerimento mostrato quando lo scorrimento arma l'annullamento. */
  cancelHint: string;
}

interface Props {
  state: PttState;
  speakerName: string | null;
  disabled: boolean;
  /** Etichette localizzate secondo la lingua d'ascolto del partecipante. */
  labels: PttLabels;
  onPress: () => void;
  onRelease: () => void;
  /**
   * Annulla l'enunciato (scorri via mentre parli, o Esc su desktop): l'audio
   * viene scartato senza tradurlo. Presente solo quando l'annullamento è
   * efficace (es. tempistica consecutiva): assente, il gesto è premi/rilascia.
   */
  onCancel?: () => void;
}

/**
 * Pulsante Push-to-Talk (§2.2). Tre stati sincronizzati col server:
 *  - Libero (verde): tieni premuto per trasmettere
 *  - In Trasmissione (rosso): microfono aperto
 *  - Bloccato (grigio): un altro partecipante occupa il canale,
 *    il pulsante è disabilitato via software.
 *
 * Quando `onCancel` è fornito, scorrere via mentre si tiene premuto (o premere
 * Esc su desktop) **annulla** l'enunciato senza tradurlo — niente token sprecati.
 */
export function PTTButton({
  state,
  speakerName,
  disabled,
  labels,
  onPress,
  onRelease,
  onCancel,
}: Props) {
  const { armed, press, move, release, cancel, reset } = useHoldToTalk({
    onPress,
    onRelease,
    onCancel,
  });
  const stateLabel: Record<PttState, string> = {
    free: labels.free,
    talking: labels.talking,
    blocked: labels.blocked,
  };

  // La barra spaziatrice funziona da PTT su desktop; Esc annulla l'enunciato.
  useEffect(() => {
    const isBlocked = disabled || state === "blocked";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space" && !event.repeat && !isBlocked) {
        const target = event.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "SELECT") return;
        event.preventDefault();
        press(0, 0);
      } else if (event.code === "Escape") {
        cancel();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") release();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [disabled, state, press, release, cancel]);

  // Rilascio di sicurezza se il canale viene perso mentre si tiene premuto.
  useEffect(() => {
    if (state === "blocked") reset();
  }, [state, reset]);

  const blocked = disabled || state === "blocked";

  return (
    <div className="ptt">
      <button
        type="button"
        className={`ptt-button ptt-${state}${armed ? " armed" : ""}`}
        disabled={blocked}
        aria-pressed={state === "talking"}
        aria-label={stateLabel[state]}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          if (!blocked) press(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => move(event.clientX, event.clientY)}
        onPointerUp={release}
        onPointerCancel={release}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span className="ptt-icon" aria-hidden="true">
          {state === "blocked" ? <LockIcon size={64} /> : <MicIcon size={64} />}
        </span>
      </button>
      <p className="ptt-label" role="status">
        {armed ? (
          <em className="ptt-cancel-hint">{labels.cancelHint}</em>
        ) : state === "blocked" && speakerName ? (
          <em>{labels.speaking(speakerName)}</em>
        ) : (
          stateLabel[state]
        )}
      </p>
    </div>
  );
}
