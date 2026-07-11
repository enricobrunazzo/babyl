/**
 * Interfaccia del motore di traduzione Speech-to-Speech.
 *
 * Il paradigma Push-to-Talk produce enunciati discreti: l'audio del parlante
 * viene accodato con appendAudio() mentre il pulsante è premuto e la
 * traduzione parte al rilascio (commit). Una sessione traduce una coppia di
 * lingue (source → target) e viene riusata per gli enunciati successivi,
 * così il provider mantiene il contesto della conversazione.
 *
 * La tempistica (streaming / interview / consecutive) è decisa dalla stanza e
 * passata a createSession: cambia come il motore segmenta il parlato.
 */

import type { TranslationTiming } from "../../../shared/protocol.ts";

export interface UtteranceCallbacks {
  /**
   * Chunk audio tradotto (PCM16 mono 24 kHz, base64). `speakerId` è il
   * parlante che ha pronunciato il segmento da cui nasce questo audio (vedi
   * setSpeaker): la traduzione rientra in ritardo e va instradata in base a
   * lui, non a chi tiene il canale quando la coda arriva.
   */
  onAudio(chunkBase64: string, speakerId: string): void;
  /** Trascrizione della traduzione, per i sottotitoli live. */
  onTranscript(text: string, final: boolean, speakerId: string): void;
  onError(error: Error): void;
}

export interface TranslationSession {
  readonly sourceLang: string;
  readonly targetLang: string;
  /**
   * Dichiara chi pronuncia l'audio accodato da qui in poi. Il provider tiene
   * l'associazione per segmento (FIFO): se un altro peer prende il PTT mentre
   * la traduzione del segmento precedente è ancora in generazione, audio e
   * sottotitoli restano attribuiti al parlante giusto.
   */
  setSpeaker(speakerId: string): void;
  appendAudio(base64Pcm: string): void;
  /** Fine dell'enunciato (rilascio PTT): avvia la traduzione. */
  commit(): void;
  /**
   * Scarta l'audio accumulato per l'enunciato corrente senza tradurlo (svuota
   * il buffer d'ingresso). Usato per l'annullamento: in consecutiva non è
   * ancora partita alcuna generazione, quindi non si spende alcun token.
   */
  discard(): void;
  /**
   * Annulla la generazione della traduzione eventualmente in corso, così il
   * motore smette di produrre l'audio residuo (token risparmiati). No-op se non
   * c'è una risposta attiva.
   */
  cancelResponse(): void;
  close(): void;
}

export interface TranslationProvider {
  readonly name: string;
  createSession(
    sourceLang: string,
    targetLang: string,
    callbacks: UtteranceCallbacks,
    timing: TranslationTiming,
  ): Promise<TranslationSession>;
}
