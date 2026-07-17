import qrcode from "qrcode-generator";
import { BabylMark } from "./BabylLogo";

interface Props {
  /** Testo da codificare (tipicamente il link della stanza). */
  text: string;
  /** Lato del QR in pixel. */
  size?: number;
  /** Mostra il marchio babyl al centro del codice (default: sì). */
  logo?: boolean;
}

/** Moduli di "quiet zone" (bordo bianco) attorno al codice: lo standard ne
 *  chiede almeno 4. Molti scanner Android non agganciano il QR senza. */
const QUIET = 4;

/**
 * QR code renderizzato come SVG (nitido a qualsiasi dimensione, nessun canvas).
 * Codifica il link della stanza per l'accesso "zero digitazione" da telefono.
 *
 * Robustezza di lettura:
 * - correzione d'errore "H" (recupera ~30%), così regge il marchio al centro
 *   e le scansioni difficili (schermo storto, riflessi) tipiche di Android;
 * - quiet zone di 4 moduli inclusa nel riquadro (bordo bianco obbligatorio);
 * - moduli scuri fusi per riga in rettangoli contigui: niente fessure di
 *   antialiasing tra un modulo e l'altro che confonderebbero il decoder.
 */
export function QRCode({ text, size = 220, logo = true }: Props) {
  // "H": massima correzione d'errore → tollera il logo al centro e letture
  // imperfette. Il costo è un codice più denso, irrilevante per un URL breve.
  const qr = qrcode(0, "H");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  // La quiet zone vive dentro `size`: il modulo si calcola sul totale
  // count + 2·QUIET, poi si trasla del bordo bianco.
  const cell = size / (count + QUIET * 2);
  const offset = QUIET * cell;
  // Piccolo debordo per saldare i moduli adiacenti (evita fessure chiare).
  const bleed = cell * 0.03;

  // Fusione per riga: ogni sequenza contigua di moduli scuri diventa un solo
  // rettangolo. Meno path, e soprattutto nessuna cucitura orizzontale.
  const rects: string[] = [];
  for (let row = 0; row < count; row++) {
    let runStart = -1;
    for (let col = 0; col <= count; col++) {
      const dark = col < count && qr.isDark(row, col);
      if (dark && runStart === -1) {
        runStart = col;
      } else if (!dark && runStart !== -1) {
        const x = offset + runStart * cell;
        const y = offset + row * cell;
        const w = (col - runStart) * cell + bleed;
        const h = cell + bleed;
        rects.push(
          `M${x.toFixed(2)} ${y.toFixed(2)}h${w.toFixed(2)}v${h.toFixed(2)}h-${w.toFixed(2)}z`,
        );
        runStart = -1;
      }
    }
  }

  // Riquadro bianco al centro che "sbianca" i moduli sotto il marchio.
  const box = size * 0.24;
  const boxPos = (size - box) / 2;
  const markSize = box * 0.82;
  const markPos = (size - markSize) / 2;

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
      <path d={rects.join("")} fill="#000000" />
      {logo && (
        <>
          <rect
            x={boxPos.toFixed(2)}
            y={boxPos.toFixed(2)}
            width={box.toFixed(2)}
            height={box.toFixed(2)}
            rx={(box * 0.22).toFixed(2)}
            fill="#ffffff"
          />
          <svg
            x={markPos.toFixed(2)}
            y={markPos.toFixed(2)}
            width={markSize.toFixed(2)}
            height={markSize.toFixed(2)}
            viewBox="0 0 100 100"
            aria-hidden="true"
          >
            <BabylMark size={100} />
          </svg>
        </>
      )}
    </svg>
  );
}
