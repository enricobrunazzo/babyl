import WebSocket from "ws";
import type { TranslationTiming } from "../../../shared/protocol.ts";
import type {
  TranslationProvider,
  TranslationSession,
  UtteranceCallbacks,
} from "./provider.ts";

const REALTIME_URL = "wss://api.openai.com/v1/realtime";
const SAMPLE_RATE = 24000;

/**
 * Coda di silenzio (600 ms di PCM16 a zero) accodata al rilascio del PTT nelle
 * modalità a VAD: fa scattare il VAD sull'ultimo segmento di parlato senza
 * bisogno del commit manuale, che confliggerebbe col VAD server-side.
 */
const TRAILING_SILENCE = Buffer.alloc(SAMPLE_RATE * 0.6 * 2).toString("base64");

/** Configurazione della segmentazione derivata dalla tempistica di stanza. */
type TurnConfig =
  | { kind: "vad"; silenceMs: number; prefixMs: number }
  | { kind: "manual" };

function turnConfigFor(timing: TranslationTiming): TurnConfig {
  switch (timing) {
    case "consecutive":
      // Nessun VAD: si traduce solo al rilascio del PTT (commit manuale).
      return { kind: "manual" };
    case "interview":
      // Pausa di segmentazione più lunga: le pause retoriche di una domanda
      // non spezzano la frase, così l'ascoltatore riceve enunciati interi.
      return { kind: "vad", silenceMs: 900, prefixMs: 500 };
    case "streaming":
    default:
      // Simultanea reattiva: segmenta sulle brevi pause naturali del parlato.
      return { kind: "vad", silenceMs: 500, prefixMs: 300 };
  }
}

/**
 * Un fallimento di handshake è ritentabile se è transitorio: 5xx (incluso il
 * 503 di sovraccarico OpenAI), 429 (rate limit) o un errore di rete. I 4xx di
 * autenticazione/permessi/modello (401/403/404) no: non cambiano riprovando.
 */
function isRetryable(error: Error): boolean {
  const match = error.message.match(/Unexpected server response: (\d+)/);
  if (match) {
    const code = Number(match[1]);
    return code >= 500 || code === 429;
  }
  // Nessun codice HTTP = errore di rete (ECONNRESET, ETIMEDOUT, …): ritentabile.
  return true;
}

export class OpenAIRealtimeProvider implements TranslationProvider {
  readonly name = "openai-realtime";

  constructor(
    private apiKey: string,
    private model = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime",
    private voice = process.env.OPENAI_REALTIME_VOICE ?? "marin",
  ) {}

  /**
   * Apre il WebSocket Realtime ritentando i fallimenti transitori (OpenAI
   * sovraccarico → 503, rate limit → 429, errori di rete) con backoff
   * esponenziale. Fallisce subito su errori non ritentabili (401/403/404):
   * chiave, permessi o modello sbagliati non migliorano riprovando.
   */
  private async openSocket(): Promise<WebSocket> {
    const url = `${REALTIME_URL}?model=${encodeURIComponent(this.model)}`;
    const maxAttempts = 4;
    let lastError: Error = new Error("apertura realtime fallita");

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(500 * 2 ** (attempt - 1), 4000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      try {
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", (error) => reject(error));
        });
        return ws;
      } catch (error) {
        lastError = error as Error;
        try {
          ws.terminate();
        } catch {
          // socket già chiuso
        }
        if (!isRetryable(lastError)) break;
      }
    }
    throw lastError;
  }

  async createSession(
    sourceLang: string,
    targetLang: string,
    callbacks: UtteranceCallbacks,
    timing: TranslationTiming,
  ): Promise<TranslationSession> {
    const turn = turnConfigFor(timing);
    const useVad = turn.kind === "vad";

    const instructions =
      `You are a professional simultaneous interpreter. ` +
      `The speaker talks in "${sourceLang}". ` +
      `Translate everything into "${targetLang}". ` +
      `Speak only the translation. ` +
      `Do not answer questions. ` +
      `Do not add comments. ` +
      `Do not summarize. ` +
      `Preserve tone, meaning, and intent.`;

    const ws = await this.openSocket();

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
            turn_detection: useVad
              ? {
                  // Segmentazione sulle pause naturali del parlato: ogni
                  // segmento viene tradotto mentre il parlante prosegue.
                  type: "server_vad",
                  threshold: 0.5,
                  prefix_padding_ms: turn.prefixMs,
                  silence_duration_ms: turn.silenceMs,
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

    // Vero mentre il motore sta generando una risposta (tra response.created e
    // response.done): guardia per non inviare response.cancel a vuoto.
    let responseActive = false;

    ws.on("message", (raw) => {
      let event: { type?: string; [key: string]: unknown };

      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (event.type) {
        // Traccia se una risposta è in generazione, così cancelResponse() invia
        // response.cancel solo quando c'è davvero qualcosa da annullare (un
        // response.cancel a vuoto verrebbe segnalato come errore dal motore).
        case "response.created": {
          responseActive = true;
          break;
        }
        case "response.done":
        case "response.cancelled": {
          responseActive = false;
          break;
        }

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

        if (useVad) {
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

      discard() {
        // Enunciato annullato: butta l'audio accumulato senza tradurlo. In
        // consecutiva non è ancora partita alcuna generazione, quindi qui non
        // si spende nulla; con VAD annulla comunque una risposta eventualmente
        // in corso sull'ultimo segmento.
        if (!buffered) return;
        buffered = false;
        send({ type: "input_audio_buffer.clear" });
        if (responseActive) send({ type: "response.cancel" });
      },

      cancelResponse() {
        // Interruzione: ferma la generazione in corso così il motore smette di
        // produrre l'audio residuo (token risparmiati).
        if (!responseActive) return;
        send({ type: "response.cancel" });
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
