import { useEffect, useState, type CSSProperties } from "react";
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
  /** Suggerimento del gesto "scorri su per bloccare" il microfono. */
  lockHint: string;
  /** Etichetta del microfono bloccato a mani libere: tocca per fermare. */
  lockedStop: string;
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
  /**
   * Abilita il blocco a mani libere (scorri su): il microfono resta aperto al
   * rilascio finché non si tocca per fermare. Utile per interventi lunghi
   * (relatore, stanza). Default: attivo.
   */
  lockable?: boolean;
}

/**
 * Pulsante Push-to-Talk (§2.2). Tre stati sincronizzati col server:
 *  - Libero (verde): tieni premuto per trasmettere
 *  - In Trasmissione (rosso): microfono aperto
 *  - Bloccato (grigio): un altro partecipante occupa il canale,
 *    il pulsante è disabilitato via software.
 *
 * Gesti mentre si tiene premuto:
 *  - scorri **su** → blocca il microfono a mani libere (per parlare a lungo);
 *    si ferma con un tocco. Attivo se `lockable`.
 *  - scorri **via** (o Esc) → annulla l'enunciato senza tradurlo, quando
 *    `onCancel` è fornito (es. tempistica consecutiva).
 */
export function PTTButton({
  state,
  speakerName,
  disabled,
  labels,
  onPress,
  onRelease,
  onCancel,
  lockable = true,
}: Props) {
  // Blocco a mani libere: il microfono resta aperto dopo il rilascio.
  const [locked, setLocked] = useState(false);
  const { armed, lockArmed, lockProgress, press, move, release, cancel, reset } =
    useHoldToTalk({
      onPress,
      onRelease,
      onCancel,
      onLock: lockable ? () => setLocked(true) : undefined,
    });
  // Ferma la trasmissione bloccata (chiude il microfono a mani libere).
  const stopLock = () => {
    setLocked(false);
    onRelease();
  };

  // La barra spaziatrice funziona da PTT su desktop; Esc annulla l'enunciato.
  useEffect(() => {
    const isBlocked = disabled || state === "blocked";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space" && !event.repeat && !isBlocked) {
        const target = event.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "SELECT") return;
        event.preventDefault();
        // Se bloccato a mani libere, lo spazio ferma invece di riaprire.
        if (locked) stopLock();
        else press(0, 0);
      } else if (event.code === "Escape") {
        if (locked) stopLock();
        else cancel();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space" && !locked) release();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, state, locked, press, release, cancel]);

  // Rilascio di sicurezza se il canale viene perso mentre si tiene premuto o
  // mentre il microfono è bloccato a mani libere.
  useEffect(() => {
    if (state === "blocked") {
      reset();
      setLocked(false);
    }
  }, [state, reset]);

  const blocked = disabled || state === "blocked";
  const armedNow = armed && !locked;
  // Il lucchetto bersaglio compare solo quando serve: mentre si trasmette (per
  // scorrerci sopra) o quando il microfono è già bloccato.
  const showLock = lockable && (state === "talking" || locked);

  // Testo di stato mostrato dentro la pillola, secondo la situazione corrente.
  const pillText = locked
    ? labels.lockedStop
    : armedNow
      ? labels.cancelHint
      : state === "blocked"
        ? speakerName
          ? labels.speaking(speakerName)
          : labels.blocked
        : state === "talking"
          ? lockable
            ? labels.lockHint
            : labels.talking
          : labels.free;

  return (
    <div className="ptt">
      <button
        type="button"
        className={`ptt-pill ptt-${state}${armedNow ? " armed" : ""}${
          lockArmed ? " lock-armed" : ""
        }${locked ? " locked" : ""}`}
        style={{ "--p": locked ? 0 : lockProgress } as CSSProperties}
        disabled={blocked && !locked}
        aria-pressed={state === "talking" || locked}
        aria-label={pillText}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          // Se già bloccato a mani libere, un tocco ferma la trasmissione.
          if (locked) {
            stopLock();
            return;
          }
          if (!blocked) press(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => {
          if (!locked) move(event.clientX, event.clientY);
        }}
        onPointerUp={() => {
          if (!locked) release();
        }}
        onPointerCancel={() => {
          if (!locked) release();
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span className="ptt-pill-fill" aria-hidden="true" />
        <span className="ptt-pill-text" aria-hidden="true">
          {pillText}
        </span>
        <span className="ptt-pill-handle" aria-hidden="true">
          <MicIcon size={26} />
        </span>
        {showLock && (
          <span className="ptt-pill-lock" aria-hidden="true">
            <LockIcon size={20} />
          </span>
        )}
      </button>
    </div>
  );
}
