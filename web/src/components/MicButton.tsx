import { useHoldToTalk } from "../lib/holdToTalk";
import { MicIcon } from "./icons";

interface Props {
  flag: string;
  name: string;
  /** aria-label localizzato «tieni premuto per parlare in <lingua>». */
  holdLabel: string;
  /** Etichetta mostrata quando lo scorrimento arma l'annullamento. */
  cancelLabel: string;
  /** true mentre questa lingua sta trasmettendo. */
  recording: boolean;
  disabled: boolean;
  onPress: () => void;
  onRelease: () => void;
  /** Annulla l'enunciato (scorri via mentre tieni premuto): audio scartato. */
  onCancel: () => void;
}

/**
 * Pulsante microfono push-to-talk per una lingua (modalità single-device):
 * tieni premuto per parlare in quella lingua, la traduzione esce nell'altra.
 * Scorri via mentre parli per **annullare** l'enunciato senza tradurlo (es. se
 * l'altra persona parla sopra) — così non si sprecano token.
 */
export function MicButton({
  flag,
  name,
  holdLabel,
  cancelLabel,
  recording,
  disabled,
  onPress,
  onRelease,
  onCancel,
}: Props) {
  const hold = useHoldToTalk({ onPress, onRelease, onCancel });

  return (
    <button
      type="button"
      className={`mic-button${recording ? " recording" : ""}${
        hold.armed ? " armed" : ""
      }`}
      disabled={disabled}
      aria-pressed={recording}
      aria-label={holdLabel}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        if (!disabled) hold.press(event.clientX, event.clientY);
      }}
      onPointerMove={(event) => hold.move(event.clientX, event.clientY)}
      onPointerUp={hold.release}
      onPointerCancel={hold.release}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span className="mic-button-flag" aria-hidden="true">
        {hold.armed ? "✕" : flag}
      </span>
      <MicIcon size={40} className="mic-button-icon" />
      <span className="mic-button-name">{hold.armed ? cancelLabel : name}</span>
    </button>
  );
}
