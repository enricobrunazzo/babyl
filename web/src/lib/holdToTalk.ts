import { useCallback, useRef, useState } from "react";

/**
 * Oltre questa distanza (px) dal punto di pressione, il rilascio **annulla**
 * l'enunciato invece di inviarlo: è il gesto "scorri per annullare" familiare
 * dai messaggi vocali. Sotto la soglia si torna alla trasmissione normale.
 */
const CANCEL_THRESHOLD_PX = 80;

/**
 * Spostamento verticale verso l'alto (px) oltre il quale il rilascio **blocca**
 * il microfono a mani libere invece di chiuderlo: è il gesto "scorri su per
 * bloccare" dei messaggi vocali. Utile quando si parla a lungo (relatore,
 * stanza) senza tenere premuto. Attivo solo se `onLock` è fornito.
 */
const LOCK_THRESHOLD_PX = 64;

export interface HoldToTalk {
  /** true quando lo scorrimento ha armato l'annullamento (rilascia per annullare). */
  armed: boolean;
  /** true quando lo scorrimento verso l'alto ha armato il blocco (rilascia per bloccare). */
  lockArmed: boolean;
  /** Avvia il gesto (pressione) a partire dalle coordinate del puntatore. */
  press(x: number, y: number): void;
  /** Aggiorna gli stati "armato"/"blocco armato" in base allo spostamento. */
  move(x: number, y: number): void;
  /** Termina il gesto: invia, annulla se armato, o blocca se il blocco è armato. */
  release(): void;
  /** Annulla esplicitamente il gesto in corso (es. tasto Esc su desktop). */
  cancel(): void;
  /** Chiude il gesto senza inviare né annullare (es. canale perso). */
  reset(): void;
}

/**
 * Gesto push-to-talk con "scorri per annullare" e "scorri su per bloccare",
 * condiviso da MicButton (single device) e PTTButton. Se `onCancel` è assente il
 * gesto non offre l'annullamento; se `onLock` è assente non offre il blocco a
 * mani libere (nessuna regressione per le modalità in cui non hanno effetto).
 */
export function useHoldToTalk(opts: {
  onPress: () => void;
  onRelease: () => void;
  onCancel?: () => void;
  /** Blocca il microfono a mani libere (scorri su): non chiude al rilascio. */
  onLock?: () => void;
}): HoldToTalk {
  const { onPress, onRelease, onCancel, onLock } = opts;
  const holding = useRef(false);
  const origin = useRef({ x: 0, y: 0 });
  // Ref oltre allo state: il gestore di rilascio legge il valore corrente senza
  // dipendere dalla chiusura React (evita esiti "armati" obsoleti).
  const armedRef = useRef(false);
  const lockArmedRef = useRef(false);
  const [armed, setArmed] = useState(false);
  const [lockArmed, setLockArmed] = useState(false);

  const setArmedValue = useCallback((value: boolean) => {
    if (armedRef.current === value) return;
    armedRef.current = value;
    setArmed(value);
  }, []);

  const setLockArmedValue = useCallback((value: boolean) => {
    if (lockArmedRef.current === value) return;
    lockArmedRef.current = value;
    setLockArmed(value);
  }, []);

  const press = useCallback(
    (x: number, y: number) => {
      if (holding.current) return;
      holding.current = true;
      origin.current = { x, y };
      setArmedValue(false);
      setLockArmedValue(false);
      onPress();
    },
    [onPress, setArmedValue, setLockArmedValue],
  );

  const move = useCallback(
    (x: number, y: number) => {
      if (!holding.current) return;
      const dx = x - origin.current.x;
      const dy = y - origin.current.y;
      // Precedenza al blocco: uno scorrimento chiaramente verso l'alto blocca
      // (e non annulla), così i due gesti non si confondono.
      if (onLock && dy <= -LOCK_THRESHOLD_PX && Math.abs(dy) >= Math.abs(dx)) {
        setLockArmedValue(true);
        setArmedValue(false);
      } else if (onCancel && Math.hypot(dx, dy) > CANCEL_THRESHOLD_PX) {
        setArmedValue(true);
        setLockArmedValue(false);
      } else {
        setArmedValue(false);
        setLockArmedValue(false);
      }
    },
    [onCancel, onLock, setArmedValue, setLockArmedValue],
  );

  const release = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    const lock = lockArmedRef.current && Boolean(onLock);
    const cancel = armedRef.current && Boolean(onCancel);
    setArmedValue(false);
    setLockArmedValue(false);
    if (lock) onLock!();
    else if (cancel) onCancel!();
    else onRelease();
  }, [onCancel, onLock, onRelease, setArmedValue, setLockArmedValue]);

  const cancel = useCallback(() => {
    if (!holding.current || !onCancel) return;
    holding.current = false;
    setArmedValue(false);
    setLockArmedValue(false);
    onCancel();
  }, [onCancel, setArmedValue, setLockArmedValue]);

  const reset = useCallback(() => {
    holding.current = false;
    setArmedValue(false);
    setLockArmedValue(false);
  }, [setArmedValue, setLockArmedValue]);

  return { armed, lockArmed, press, move, release, cancel, reset };
}
