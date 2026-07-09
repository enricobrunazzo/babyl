import qrcode from "qrcode-generator";

interface Props {
  /** Testo da codificare (tipicamente il link della stanza). */
  text: string;
  /** Lato del QR in pixel. */
  size?: number;
}

/**
 * QR code renderizzato come SVG (nitido a qualsiasi dimensione, nessun canvas).
 * Codifica il link della stanza per l'accesso "zero digitazione" da telefono.
 */
export function QRCode({ text, size = 220 }: Props) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const cell = size / count;

  const cells: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        const x = (col * cell).toFixed(2);
        const y = (row * cell).toFixed(2);
        cells.push(`M${x} ${y}h${cell.toFixed(2)}v${cell.toFixed(2)}h-${cell.toFixed(2)}z`);
      }
    }
  }

  return (
    <svg
      className="qr-code"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="QR code della stanza"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={cells.join("")} fill="#000000" />
    </svg>
  );
}
