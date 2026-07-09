/**
 * Interfaccia del motore di traduzione Speech-to-Speech.
 *
 * Il paradigma Push-to-Talk produce enunciati discreti: l'audio del parlante
 * viene accodato con appendAudio() mentre il pulsante è premuto e la
 * traduzione parte al rilascio (commit). Una sessione traduce una coppia di
 * lingue (source → target) e viene riusata per gli enunciati successivi,
 * così il provider mantiene il contesto della conversazione.
 */

export interface UtteranceCallbacks {
  /** Chunk audio tradotto (PCM16 mono 24 kHz, base64). */
  onAudio(chunkBase64: string): void;
  /** Trascrizione della traduzione, per i sottotitoli live. */
  onTranscript(text: string, final: boolean): void;
  onError(error: Error): void;
}

export interface TranslationSession {
  readonly sourceLang: string;
  readonly targetLang: string;
  appendAudio(base64Pcm: string): void;
  /** Fine dell'enunciato (rilascio PTT): avvia la traduzione. */
  commit(): void;
  close(): void;
}

export interface TranslationProvider {
  readonly name: string;
  createSession(
    sourceLang: string,
    targetLang: string,
    callbacks: UtteranceCallbacks,
  ): Promise<TranslationSession>;
}
