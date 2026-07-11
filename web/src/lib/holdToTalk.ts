import { useCallback, useRef, useState } from "react";

/**
 * Oltre questa distanza (px) dal punto di pressione, il rilascio **annulla**
 * l'enunciato invece di inviarlo: è il gesto "scorri per annullare" familiare
 * dai messaggi vocali. Sotto la soglia si torna alla trasmissione normale.
 */
const CANCEL_THRESHOLD_PX = 80;

export interface HoldToTalk {
  /** true quando lo scorrimento ha armato l'annullamento (rilascia per annullare). */
  armed: boolean;
  /** Avvia il gesto (pressione) a partire dalle coordinate del puntatore. */
  press(x: number, y: number): void;
  /** Aggiorna lo stato "armato" in base allo spostamento del puntatore. */
  move(x: number, y: number): void;
  /** Termina il gesto: invia (rilascio) o annulla se armato. */
  release(): void;
  /** Annulla esplicitamente il gesto in corso (es. tasto Esc su desktop). */
  cancel(): void;
  /** Chiude il gesto senza inviare né annullare (es. canale perso). */
  reset(): void;
}

/**
 * Gesto push-to-talk con "scorri per annullare", condiviso da MicButton (single
 * device) e PTTButton. Se `onCancel` è assente il gesto è un semplice premi e
 * rilascia, senza annullamento (nessuna regressione per le modalità in cui
 * l'annullamento non ha effetto, es. traduzione già emessa in streaming).
 */
export function useHoldToTalk(opts: {
  onPress: () => void;
  onRelease: () => void;
  onCancel?: () => void;
}): HoldToTalk {
  const { onPress, onRelease, onCancel } = opts;
  const holding = useRef(false);
  const origin = useRef({ x: 0, y: 0 });
  // Ref oltre allo state: il gestore di rilascio legge il valore corrente senza
  // dipendere dalla chiusura React (evita esiti "armati" obsoleti).
  const armedRef = useRef(false);
  const [armed, setArmed] = useState(false);

  const setArmedValue = useCallback((value: boolean) => {
    if (armedRef.current === value) return;
    armedRef.current = value;
    setArmed(value);
  }, []);

  const press = useCallback(
    (x: number, y: number) => {
      if (holding.current) return;
      holding.current = true;
      origin.current = { x, y };
      setArmedValue(false);
      onPress();
    },
    [onPress, setArmedValue],
  );

  const move = useCallback(
    (x: number, y: number) => {
      if (!holding.current || !onCancel) return;
      const dist = Math.hypot(x - origin.current.x, y - origin.current.y);
      setArmedValue(dist > CANCEL_THRESHOLD_PX);
    },
    [onCancel, setArmedValue],
  );

  const release = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    const cancel = armedRef.current && Boolean(onCancel);
    setArmedValue(false);
    if (cancel) onCancel!();
    else onRelease();
  }, [onCancel, onRelease, setArmedValue]);

  const cancel = useCallback(() => {
    if (!holding.current || !onCancel) return;
    holding.current = false;
    setArmedValue(false);
    onCancel();
  }, [onCancel, setArmedValue]);

  const reset = useCallback(() => {
    holding.current = false;
    setArmedValue(false);
  }, [setArmedValue]);

  return { armed, press, move, release, cancel, reset };
}
