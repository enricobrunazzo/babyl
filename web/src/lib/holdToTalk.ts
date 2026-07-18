import { useCallback, useRef, useState } from "react";

/**
 * Oltre questa distanza (px) dal punto di pressione, il rilascio **annulla**
 * l'enunciato invece di inviarlo: è il gesto "scorri per annullare" familiare
 * dai messaggi vocali. Sotto la soglia si torna alla trasmissione normale.
 */
const CANCEL_THRESHOLD_PX = 80;

/**
 * Spostamento orizzontale verso **destra** (px) oltre il quale il rilascio
 * **blocca** il microfono a mani libere invece di chiuderlo: è il gesto "scorri
 * a destra per bloccare", nello stile dello slide-to-unlock. Utile quando si
 * parla a lungo (relatore, stanza) senza tenere premuto. Attivo solo se
 * `onLock` è fornito.
 */
const LOCK_THRESHOLD_PX = 120;

export interface HoldToTalk {
  /** true quando lo scorrimento ha armato l'annullamento (rilascia per annullare). */
  armed: boolean;
  /** true quando lo scorrimento verso destra ha armato il blocco (rilascia per bloccare). */
  lockArmed: boolean;
  /** Avanzamento dello slide-to-lock, 0→1 (per animare la maniglia). */
  lockProgress: number;
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
 * Gesto push-to-talk con "scorri per annullare" e "scorri a destra per
 * bloccare", condiviso da MicButton (single device) e PTTButton. Se `onCancel` è
 * assente il gesto non offre l'annullamento; se `onLock` è assente non offre il
 * blocco a mani libere (nessuna regressione per le modalità in cui non hanno
 * effetto).
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
  const [lockProgress, setLockProgress] = useState(0);

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
      setLockProgress(0);
      onPress();
    },
    [onPress, setArmedValue, setLockArmedValue],
  );

  const move = useCallback(
    (x: number, y: number) => {
      if (!holding.current) return;
      const dx = x - origin.current.x;
      const dy = y - origin.current.y;
      // Precedenza al blocco: uno scorrimento verso **destra** (prevalentemente
      // orizzontale) alimenta lo slide-to-lock; l'altro scorrimento (sinistra o
      // verticale) oltre soglia arma l'annullamento.
      if (onLock && dx > 0 && Math.abs(dx) >= Math.abs(dy)) {
        const progress = Math.min(1, dx / LOCK_THRESHOLD_PX);
        setLockProgress(progress);
        setLockArmedValue(progress >= 1);
        setArmedValue(false);
      } else if (onCancel && Math.hypot(dx, dy) > CANCEL_THRESHOLD_PX) {
        setArmedValue(true);
        setLockArmedValue(false);
        setLockProgress(0);
      } else {
        setArmedValue(false);
        setLockArmedValue(false);
        setLockProgress(0);
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
    setLockProgress(0);
    if (lock) onLock!();
    else if (cancel) onCancel!();
    else onRelease();
  }, [onCancel, onLock, onRelease, setArmedValue, setLockArmedValue]);

  const cancel = useCallback(() => {
    if (!holding.current || !onCancel) return;
    holding.current = false;
    setArmedValue(false);
    setLockArmedValue(false);
    setLockProgress(0);
    onCancel();
  }, [onCancel, setArmedValue, setLockArmedValue]);

  const reset = useCallback(() => {
    holding.current = false;
    setArmedValue(false);
    setLockArmedValue(false);
    setLockProgress(0);
  }, [setArmedValue, setLockArmedValue]);

  return { armed, lockArmed, lockProgress, press, move, release, cancel, reset };
}
