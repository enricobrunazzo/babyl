/**
 * Dedup dei segmenti tradotti ripetuti dal motore realtime.
 *
 * Il motore Speech-to-Speech a volte va in loop e ritraduce lo stesso segmento
 * molte volte di fila (tipico con l'audio sovrapposto che il VAD richiude sulle
 * pause brevi): l'ascoltatore sente — e legge — la stessa frase ripetuta a
 * raffica. La deriva è riconoscibile perché i doppioni arrivano back-to-back,
 * a distanza di frazioni di secondo; una ripetizione *voluta* dal parlante
 * arriva invece dopo una pausa.
 *
 * Questa classe decide, per ogni risposta del motore, se l'audio va emesso o
 * scartato, confrontando la trascrizione con quella dell'ultimo segmento
 * emesso entro una finestra temporale. È volutamente priva di I/O (nessun
 * WebSocket, nessun timer) per essere testabile: il provider la pilota con gli
 * eventi Realtime e ne consuma le decisioni.
 */

/**
 * Normalizza una trascrizione per il confronto: minuscolo, spazi compattati e
 * punteggiatura di contorno rimossa, così che "App testing session." e
 * "app testing session" risultino lo stesso segmento. Speculare alla
 * normalizzazione lato client sui sottotitoli.
 */
export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "")
    .trim();
}

/** Decisione sul destino dell'audio di una risposta in corso. */
export type Decision = "keep" | "drop" | "pending";

/**
 * Finestra entro cui due segmenti identici sono considerati un loop del motore
 * (e quindi il secondo va scartato). Oltre la finestra una ripetizione è
 * ritenuta voluta e viene mantenuta. Sovrascrivibile via env per casi limite.
 */
export const DEFAULT_DEDUP_WINDOW_MS = Math.max(
  0,
  Number(process.env.OPENAI_DEDUP_WINDOW_MS ?? 4000),
);

export class SegmentDedup {
  private baselineNorm = "";
  private baselineAt = Number.NEGATIVE_INFINITY;

  constructor(
    private windowMs: number = DEFAULT_DEDUP_WINDOW_MS,
    private clock: () => number = Date.now,
  ) {}

  /** Baseline attiva solo se abbastanza recente; altrimenti "" (nessun dup). */
  private activeBaseline(): string {
    return this.clock() - this.baselineAt <= this.windowMs
      ? this.baselineNorm
      : "";
  }

  /**
   * Stato iniziale di una nuova risposta. Senza una baseline recente non c'è
   * nulla da deduplicare: "keep" fa streammare l'audio subito, a latenza zero.
   * Con una baseline recente si parte "pending" per osservare la trascrizione
   * e distinguere un doppione (da scartare) da un segmento nuovo (da emettere).
   */
  begin(): Decision {
    return this.activeBaseline() ? "pending" : "keep";
  }

  /**
   * Valuta la trascrizione accumulata finora. Appena diverge dalla baseline il
   * segmento è nuovo → "keep" (e l'audio bufferizzato va emesso). Se a fine
   * risposta (`done`) la trascrizione resta un prefisso della baseline è un
   * doppione → "drop". Finché è un prefisso e la risposta non è finita, resta
   * "pending".
   */
  evaluate(transcriptSoFar: string, done: boolean): Decision {
    const baseline = this.activeBaseline();
    if (!baseline) return "keep";
    const current = normalizeTranscript(transcriptSoFar);
    // Più lungo della baseline, o diverge nel prefisso: è un segmento nuovo.
    if (current.length > baseline.length) return "keep";
    if (!baseline.startsWith(current)) return "keep";
    // È un prefisso della baseline: doppione (pieno o troncato) se la risposta
    // è conclusa, altrimenti ancora indeciso.
    return done ? "drop" : "pending";
  }

  /** Registra il segmento appena emesso come nuova baseline del dedup. */
  commitKept(finalTranscript: string): void {
    this.baselineNorm = normalizeTranscript(finalTranscript);
    this.baselineAt = this.clock();
  }

  /**
   * Prolunga la finestra della baseline corrente: chiamata quando si scarta un
   * doppione, così la finestra misura l'intervallo *tra ripetizioni* e non il
   * tempo dall'originale. Un loop a raffica resta soppresso comunque a lungo;
   * una ripetizione dopo una pausa (> finestra) torna a essere mantenuta.
   */
  touch(): void {
    if (this.baselineNorm) this.baselineAt = this.clock();
  }

  /**
   * Azzera la baseline: usato al cambio di parlante, perché la stessa frase
   * detta da un'altra persona è legittima e non va scartata.
   */
  reset(): void {
    this.baselineNorm = "";
    this.baselineAt = Number.NEGATIVE_INFINITY;
  }
}
