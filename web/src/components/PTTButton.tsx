import { useCallback, useEffect, useRef } from "react";
import type { PttState } from "../lib/roomClient";
import { LockIcon, MicIcon } from "./icons";

interface Props {
  state: PttState;
  speakerName: string | null;
  disabled: boolean;
  onPress: () => void;
  onRelease: () => void;
}

const LABELS: Record<PttState, string> = {
  free: "Tieni premuto per parlare",
  talking: "Stai parlando…",
  blocked: "Canale occupato",
};

/**
 * Pulsante Push-to-Talk (§2.2). Tre stati sincronizzati col server:
 *  - Libero (verde): tieni premuto per trasmettere
 *  - In Trasmissione (rosso): microfono aperto
 *  - Bloccato (grigio): un altro partecipante occupa il canale,
 *    il pulsante è disabilitato via software.
 */
export function PTTButton({
  state,
  speakerName,
  disabled,
  onPress,
  onRelease,
}: Props) {
  const holding = useRef(false);

  const press = useCallback(() => {
    if (holding.current) return;
    holding.current = true;
    onPress();
  }, [onPress]);

  const release = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    onRelease();
  }, [onRelease]);

  // La barra spaziatrice funziona da PTT su desktop.
  useEffect(() => {
    const isBlocked = disabled || state === "blocked";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space" && !event.repeat && !isBlocked) {
        const target = event.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "SELECT") return;
        event.preventDefault();
        press();
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
  }, [disabled, state, press, release]);

  // Rilascio di sicurezza se il canale viene perso mentre si tiene premuto.
  useEffect(() => {
    if (state === "blocked") holding.current = false;
  }, [state]);

  const blocked = disabled || state === "blocked";

  return (
    <div className="ptt">
      <button
        type="button"
        className={`ptt-button ptt-${state}`}
        disabled={blocked}
        aria-pressed={state === "talking"}
        aria-label={LABELS[state]}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          if (!blocked) press();
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span className="ptt-icon" aria-hidden="true">
          {state === "blocked" ? <LockIcon size={64} /> : <MicIcon size={64} />}
        </span>
      </button>
      <p className="ptt-label" role="status">
        {state === "blocked" && speakerName ? (
          <em>«{speakerName}» sta parlando…</em>
        ) : (
          LABELS[state]
        )}
      </p>
    </div>
  );
}
