import WebSocket from "ws";
import type {
  TranslationProvider,
  TranslationSession,
  UtteranceCallbacks,
} from "./provider.ts";

const REALTIME_URL = "wss://api.openai.com/v1/realtime";
const SAMPLE_RATE = 24000;

/**
 * Coda di silenzio (600 ms di PCM16 a zero) accodata al rilascio del PTT in
 * modalità simultanea: fa scattare il VAD sull'ultimo segmento di parlato
 * senza bisogno del commit manuale, che confliggerebbe col VAD server-side.
 */
const TRAILING_SILENCE = Buffer.alloc(SAMPLE_RATE * 0.6 * 2).toString("base64");

export class OpenAIRealtimeProvider implements TranslationProvider {
  readonly name = "openai-realtime";

  /**
   * Tempistica della traduzione:
   * - "streaming" (default): interpretazione simultanea — il VAD lato
   *   OpenAI segmenta il parlato sulle pause naturali e la voce tradotta
   *   parte mentre il parlante sta ancora parlando (effetto interprete TV);
   * - "release": consecutiva — la traduzione parte solo al rilascio del PTT.
   */
  private streaming =
    (process.env.TRANSLATION_TIMING ?? "streaming") !== "release";

  constructor(
    private apiKey: string,
    private model = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime",
    private voice = process.env.OPENAI_REALTIME_VOICE ?? "marin",
  ) {}

  async createSession(
    sourceLang: string,
    targetLang: string,
    callbacks: UtteranceCallbacks,
  ): Promise<TranslationSession> {
    const ws = new WebSocket(
      `${REALTIME_URL}?model=${encodeURIComponent(this.model)}`,
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      },
    );

    const instructions =
      `You are a professional simultaneous interpreter. ` +
      `The speaker talks in "${sourceLang}". ` +
      `Translate everything into "${targetLang}". ` +
      `Speak only the translation. ` +
      `Do not answer questions. ` +
      `Do not add comments. ` +
      `Do not summarize. ` +
      `Preserve tone, meaning, and intent.`;

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (error) => reject(error));
    });

    const send = (payload: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    };

    send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions,
        audio: {
          input: {
            format: {
              type: "audio/pcm",
              rate: SAMPLE_RATE,
            },
            turn_detection: this.streaming
              ? {
                  // Segmentazione sulle pause naturali del parlato: ogni
                  // segmento viene tradotto mentre il parlante prosegue.
                  type: "server_vad",
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 500,
                  create_response: true,
                  // La traduzione in corso non va interrotta quando il
                  // parlante riprende: deve accodarsi, non troncarsi.
                  interrupt_response: false,
                }
              : null,
          },
          output: {
            format: {
              type: "audio/pcm",
              rate: SAMPLE_RATE,
            },
            voice: this.voice,
          },
        },
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
        case "response.output_audio.delta":
        case "response.audio.delta": {
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (delta) callbacks.onAudio(delta);
          break;
        }

        case "response.output_audio_transcript.delta":
        case "response.audio_transcript.delta": {
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (delta) callbacks.onTranscript(delta, false);
          break;
        }

        case "response.output_audio_transcript.done":
        case "response.audio_transcript.done": {
          const transcript =
            typeof event.transcript === "string" ? event.transcript : "";
          callbacks.onTranscript(transcript, true);
          break;
        }

        case "error": {
          const err = event.error as { message?: string } | undefined;
          callbacks.onError(
            new Error(err?.message ?? "errore OpenAI Realtime"),
          );
          break;
        }
      }
    });

    ws.on("error", (error) => {
      callbacks.onError(error as Error);
    });

    let buffered = false;
    const streaming = this.streaming;

    return {
      sourceLang,
      targetLang,

      appendAudio(base64Pcm: string) {
        if (!base64Pcm) return;
        buffered = true;
        send({
          type: "input_audio_buffer.append",
          audio: base64Pcm,
        });
      },

      commit() {
        if (!buffered) return;
        buffered = false;

        if (streaming) {
          // Il VAD ha già tradotto i segmenti durante il parlato: qui basta
          // il silenzio in coda per fargli chiudere l'ultimo segmento.
          send({ type: "input_audio_buffer.append", audio: TRAILING_SILENCE });
          return;
        }

        send({ type: "input_audio_buffer.commit" });
        send({
          type: "response.create",
          response: {},
        });
      },

      close() {
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close();
        }
      },
    };
  }
}

export function providerFromEnv(): TranslationProvider | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAIRealtimeProvider(apiKey);
}
