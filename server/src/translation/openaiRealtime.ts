import WebSocket from "ws";
import type {
  TranslationProvider,
  TranslationSession,
  UtteranceCallbacks,
} from "./provider.ts";

const REALTIME_URL = "wss://api.openai.com/v1/realtime";

/**
 * Provider basato sulla OpenAI Realtime API (speech-to-speech nativo).
 *
 * Il PTT half-duplex si sposa con la modalità manuale dell'API: niente VAD
 * lato provider — accumuliamo l'audio con input_audio_buffer.append e al
 * rilascio del pulsante inviamo commit + response.create. L'audio tradotto
 * torna in streaming (PCM16 24 kHz) insieme alla trascrizione.
 *
 * Config: OPENAI_API_KEY (obbligatoria), OPENAI_REALTIME_MODEL (default
 * gpt-realtime-mini), OPENAI_REALTIME_VOICE (default marin).
 */
export class OpenAIRealtimeProvider implements TranslationProvider {
  readonly name = "openai-realtime";

  constructor(
    private apiKey: string,
    private model = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-mini",
    private voice = process.env.OPENAI_REALTIME_VOICE ?? "marin",
  ) {}

  async createSession(
    sourceLang: string,
    targetLang: string,
    callbacks: UtteranceCallbacks,
  ): Promise<TranslationSession> {
    const ws = new WebSocket(`${REALTIME_URL}?model=${this.model}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    const instructions =
      `You are a professional simultaneous interpreter. ` +
      `The user speaks in "${sourceLang}". Translate everything they say ` +
      `into "${targetLang}" and speak ONLY the translation, preserving tone ` +
      `and intent. Never answer questions, never add comments, never omit ` +
      `content: you are a pure interpreter.`;

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (error) => reject(error));
    });

    const send = (payload: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };

    send({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        instructions,
        voice: this.voice,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        // Niente VAD: gli enunciati sono delimitati dal PTT (commit manuale).
        turn_detection: null,
      },
    });

    ws.on("message", (raw) => {
      let event: { type?: string; [key: string]: unknown };
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (event.type) {
        // Nomi sia della versione beta sia della GA dell'API.
        case "response.audio.delta":
        case "response.output_audio.delta":
          callbacks.onAudio(String(event.delta ?? ""));
          break;
        case "response.audio_transcript.delta":
        case "response.output_audio_transcript.delta":
          callbacks.onTranscript(String(event.delta ?? ""), false);
          break;
        case "response.audio_transcript.done":
        case "response.output_audio_transcript.done":
          callbacks.onTranscript(String(event.transcript ?? ""), true);
          break;
        case "error": {
          const err = event.error as { message?: string } | undefined;
          callbacks.onError(
            new Error(err?.message ?? "errore OpenAI Realtime"),
          );
          break;
        }
      }
    });

    ws.on("close", () => {
      // La stanza ricreerà la sessione al prossimo enunciato se serve.
    });
    ws.on("error", (error) => callbacks.onError(error as Error));

    let buffered = false;

    return {
      sourceLang,
      targetLang,
      appendAudio(base64Pcm: string) {
        buffered = true;
        send({ type: "input_audio_buffer.append", audio: base64Pcm });
      },
      commit() {
        if (!buffered) return;
        buffered = false;
        send({ type: "input_audio_buffer.commit" });
        send({
          type: "response.create",
          response: { modalities: ["audio", "text"] },
        });
      },
      close() {
        ws.close();
      },
    };
  }
}

/** Costruisce il provider dalle variabili d'ambiente, o null (voce originale). */
export function providerFromEnv(): TranslationProvider | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAIRealtimeProvider(apiKey);
}
