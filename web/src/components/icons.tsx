interface IconProps {
  size?: number;
  className?: string;
}

/** Icona microfono in stile Material Design (Google). Colore via currentColor. */
export function MicIcon({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5-3c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
    </svg>
  );
}

/** Icona stanza (porta) stilizzata: sostituisce l'emoji 🚪. */
export function RoomIcon({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M6.75 3.5A1.5 1.5 0 0 1 8.25 2h7.5a1.5 1.5 0 0 1 1.5 1.5V21a1 1 0 0 1-1 1H7.75a1 1 0 0 1-1-1V3.5zm7.75 9.75a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2z"
      />
      <path d="M5.5 21.25a.75.75 0 0 1 .75-.75h11.5a.75.75 0 0 1 0 1.5H6.25a.75.75 0 0 1-.75-.75z" />
    </svg>
  );
}

/** Icona cuffie stilizzata: sostituisce l'emoji 🎧. */
export function HeadphonesIcon({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3a8 8 0 0 0-8 8v6.5A2.5 2.5 0 0 0 6.5 20H8a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H6.05A6 6 0 0 1 12 5a6 6 0 0 1 5.95 8H16a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h1.5A2.5 2.5 0 0 0 20 17.5V11a8 8 0 0 0-8-8z" />
    </svg>
  );
}

/** Mano alzata stilizzata: sostituisce l'emoji ✋. */
export function HandIcon({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M6.5 12.4V6.75a1.25 1.25 0 0 1 2.5 0v3.75h.75V4.25a1.25 1.25 0 0 1 2.5 0v6.25h.75V5a1.25 1.25 0 0 1 2.5 0v5.5h.75V7.75a1.25 1.25 0 0 1 2.5 0v7.35a6.9 6.9 0 0 1-6.9 6.9h-.7a5.5 5.5 0 0 1-3.9-1.62l-4.2-4.2a1.3 1.3 0 0 1 1.68-1.96l1.49 1.18z" />
    </svg>
  );
}

/** Altoparlante con onde: sostituisce l'emoji 🔊. */
export function SpeakerWaveIcon({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4 4 0 0 0-2.5-3.7v7.4A4 4 0 0 0 16.5 12zM14 3.5v2.1a6.5 6.5 0 0 1 0 12.8v2.1a8.5 8.5 0 0 0 0-17z" />
    </svg>
  );
}

/** Chevron verso l'alto (maniglia dello slide-to-lock). */
export function ChevronUpIcon({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M6 14l6-6 6 6" />
    </svg>
  );
}

/** X stilizzata (annullamento): sostituisce il carattere ✕. */
export function CloseIcon({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** Icona stop (quadrato arrotondato) in stile Material Design. */
export function StopIcon({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  );
}

/** Icona lucchetto in stile Material Design. Colore via currentColor. */
export function LockIcon({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
    </svg>
  );
}
