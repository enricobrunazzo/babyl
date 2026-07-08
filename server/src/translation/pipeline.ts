/**
 * Pipeline di traduzione Speech-to-Speech — punto di estensione.
 *
 * Nell'MVP l'audio viaggia peer-to-peer via WebRTC senza inferenza (provider
 * "passthrough"). Per la traduzione simultanea (target: latenza end-to-end
 * < 1.5 s) l'architettura prevede di instradare l'audio del parlante
 * attraverso un SFU/media server e applicare una pipeline in streaming:
 *
 *   audio in → VAD → STT streaming → traduzione → TTS streaming → audio out
 *   (una uscita per ciascuna lingua di destinazione presente nella stanza)
 *
 * Un provider S2S nativo (modello voice-to-voice) può sostituire l'intera
 * catena implementando questa stessa interfaccia.
 */

export interface S2SSessionConfig {
  roomId: string;
  /** Lingua del parlante (BCP-47 base, es. "it"). */
  sourceLang: string;
  /** Lingue di destinazione richieste dagli ascoltatori della stanza. */
  targetLangs: string[];
}

export interface S2SSession {
  /** Invia un chunk audio del parlante (PCM/Opus a seconda del provider). */
  pushAudio(chunk: Uint8Array): void;
  /** Chiude la sessione (rilascio del lock PTT). */
  close(): Promise<void>;
}

export interface S2SEvents {
  /** Audio tradotto pronto per una lingua di destinazione. */
  onTranslatedAudio(lang: string, chunk: Uint8Array): void;
  /** Trascrizione/parziali opzionali, utili per sottotitoli live. */
  onTranscript?(lang: string, text: string, isFinal: boolean): void;
  onError(error: Error): void;
}

export interface TranslationProvider {
  readonly name: string;
  startSession(config: S2SSessionConfig, events: S2SEvents): Promise<S2SSession>;
}

/**
 * Provider MVP: nessuna inferenza, l'audio originale è consegnato invariato
 * a tutte le lingue di destinazione. Consente di validare trasporto, PTT e UX
 * prima di collegare un motore di traduzione reale.
 */
export class PassthroughProvider implements TranslationProvider {
  readonly name = "passthrough";

  async startSession(
    config: S2SSessionConfig,
    events: S2SEvents,
  ): Promise<S2SSession> {
    return {
      pushAudio: (chunk) => {
        for (const lang of config.targetLangs) {
          events.onTranslatedAudio(lang, chunk);
        }
      },
      close: async () => {},
    };
  }
}
