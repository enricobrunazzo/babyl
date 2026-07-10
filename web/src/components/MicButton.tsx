import { useCallback, useRef } from "react";
import { MicIcon } from "./icons";

interface Props {
  flag: string;
  name: string;
  /** aria-label localizzato «tieni premuto per parlare in <lingua>». */
  holdLabel: string;
  /** true mentre questa lingua sta trasmettendo. */
  recording: boolean;
  disabled: boolean;
  onPress: () => void;
  onRelease: () => void;
}

/**
 * Pulsante microfono push-to-talk per una lingua (modalità single-device):
 * tieni premuto per parlare in quella lingua, la traduzione esce nell'altra.
 */
export function MicButton({
  flag,
  name,
  holdLabel,
  recording,
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

  return (
    <button
      type="button"
      className={`mic-button${recording ? " recording" : ""}`}
      disabled={disabled}
      aria-pressed={recording}
      aria-label={holdLabel}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        if (!disabled) press();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span className="mic-button-flag" aria-hidden="true">
        {flag}
      </span>
      <MicIcon size={40} className="mic-button-icon" />
      <span className="mic-button-name">{name}</span>
    </button>
  );
}
