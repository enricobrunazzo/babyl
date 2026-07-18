import WebSocket from "ws";
import { languagePromptName } from "../../../shared/languages.ts";
import type { TranslationTiming } from "../../../shared/protocol.ts";
import type {
  TranslationProvider,
  TranslationSession,
  UtteranceCallbacks,
} from "./provider.ts";
import { SegmentDedup } from "./dedup.ts";

const REALTIME_URL = "wss://api.openai.com/v1/realtime";
const SAMPLE_RATE = 24000;

/**
 * Sensibilità del VAD server-side (0–1). Più alta = meno reattiva al rumore di
 * fondo: nelle **pause** il brusio della sala non fa scattare segmenti spuri
 * che il modello tradurrebbe ripetendo l'ultimo enunciato. Default prudente per
 * ambienti rumorosi (eventi); alzabile via env per sale molto rumorose.
 */
const VAD_THRESHOLD = Math.min(
  1,
  Math.max(0, Number(process.env.OPENAI_VAD_THRESHOLD ?? 0.6)),
);

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

    // Nomi espansi ("Italian", non "it"): più robusti dei codici raw nel prompt.
    // Le istruzioni insistono sulla traduzione *fedele*: senza vincoli espliciti
    // il modello tende a spiegare o parafrasare il concetto nella lingua di
    // arrivo invece di rendere le parole dette (es. IT→FR restituiva una
    // spiegazione del senso, non la traduzione).
    const instructions =
      `You are a professional simultaneous interpreter. ` +
      `The speaker talks in ${languagePromptName(sourceLang)}. ` +
      `Translate everything faithfully into ${languagePromptName(targetLang)}, ` +
      `staying as close to the original words as ${languagePromptName(targetLang)} grammar allows. ` +
      `Render what the speaker says, not what they mean. ` +
      `Speak only the translation. ` +
      `Do not answer questions. ` +
      `Do not add comments. ` +
      `Do not explain, paraphrase, rephrase, interpret, or describe the meaning. ` +
      `Do not summarize or expand. ` +
      `Never repeat a previous translation. ` +
      `If the input contains no speech to translate, stay silent and output nothing. ` +
      `Preserve tone, register, and intent.`;

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
                  threshold: VAD_THRESHOLD,
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

    // Attribuzione per segmento: chi pronuncia l'audio accodato ora
    // (setSpeaker), i parlanti dei segmenti committati in attesa di risposta
    // (FIFO) e il parlante della risposta in generazione. Così la traduzione
    // che rientra in ritardo resta attribuita a chi l'ha pronunciata anche se
    // nel frattempo il canale è passato di mano.
    let currentSpeaker = "";
    const segmentSpeakers: string[] = [];
    let responseSpeaker = "";
    const attributedSpeaker = () => responseSpeaker || currentSpeaker;

    // Dedup dell'audio ripetuto dal loop del motore (vedi dedup.ts). Stato
    // per-risposta: finché il destino della risposta è "pending" i chunk audio
    // si accumulano in `pendingAudio` invece di essere inoltrati; alla prima
    // divergenza della trascrizione si emette tutto (segmento nuovo), se resta
    // un doppione si scarta.
    const dedup = new SegmentDedup();
    let audioDecision: "keep" | "drop" | "pending" = "keep";
    let pendingAudio: string[] = [];
    let responseTranscript = "";

    // Emette i chunk audio accumulati e passa in modalità streaming diretto.
    const flushPendingAudio = () => {
      const speaker = attributedSpeaker();
      for (const chunk of pendingAudio) callbacks.onAudio(chunk, speaker);
      pendingAudio = [];
    };

    // Applica la decisione del dedup alla trascrizione accumulata: appena il
    // segmento è giudicato "nuovo" libera l'audio in coda; se è un doppione lo
    // butta. No-op finché la decisione resta sospesa.
    const applyDedup = (done: boolean) => {
      if (audioDecision !== "pending") return;
      const decision = dedup.evaluate(responseTranscript, done);
      if (decision === "keep") {
        audioDecision = "keep";
        flushPendingAudio();
      } else if (decision === "drop") {
        audioDecision = "drop";
        pendingAudio = [];
      }
    };

    ws.on("message", (raw) => {
      let event: { type?: string; [key: string]: unknown };

      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (event.type) {
        // Un segmento d'ingresso è stato chiuso (dal VAD o dal commit manuale):
        // da qui nascerà una risposta, che apparterrà a chi lo ha pronunciato.
        case "input_audio_buffer.committed": {
          segmentSpeakers.push(currentSpeaker);
          break;
        }

        // Traccia se una risposta è in generazione, così cancelResponse() invia
        // response.cancel solo quando c'è davvero qualcosa da annullare (un
        // response.cancel a vuoto verrebbe segnalato come errore dal motore).
        case "response.created": {
          responseActive = true;
          responseSpeaker = segmentSpeakers.shift() ?? currentSpeaker;
          // Nuova risposta: reimposta il dedup. Senza una baseline recente si
          // parte "keep" (audio in diretta, latenza zero); con una baseline
          // recente si parte "pending" e si bufferizza finché non si sa se è
          // un doppione.
          responseTranscript = "";
          pendingAudio = [];
          audioDecision = dedup.begin();
          break;
        }
        case "response.done":
        case "response.cancelled": {
          // Risposta conclusa senza che il dedup si sia deciso (es. audio senza
          // trascrizione): meglio emettere che scartare a torto.
          if (audioDecision === "pending") {
            audioDecision = "keep";
            flushPendingAudio();
          }
          responseActive = false;
          responseSpeaker = "";
          break;
        }

        case "response.output_audio.delta":
        case "response.audio.delta": {
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (!delta) break;
          if (audioDecision === "keep") {
            callbacks.onAudio(delta, attributedSpeaker());
          } else if (audioDecision === "pending") {
            pendingAudio.push(delta);
          }
          // "drop": l'audio del doppione viene ignorato.
          break;
        }

        case "response.output_audio_transcript.delta":
        case "response.audio_transcript.delta": {
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (!delta) break;
          responseTranscript += delta;
          applyDedup(false);
          callbacks.onTranscript(delta, false, attributedSpeaker());
          break;
        }

        case "response.output_audio_transcript.done":
        case "response.audio_transcript.done": {
          const transcript =
            typeof event.transcript === "string" ? event.transcript : "";
          responseTranscript = transcript;
          applyDedup(true);
          if (audioDecision === "drop") {
            // Doppione scartato: prolunga la finestra così un loop a raffica
            // resta soppresso finché i doppioni continuano ad arrivare fitti.
            dedup.touch();
          } else {
            // Solo un segmento davvero emesso diventa baseline: i doppioni
            // successivi si confrontano con l'originale, non tra loro.
            dedup.commitKept(transcript);
          }
          callbacks.onTranscript(transcript, true, attributedSpeaker());
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

    // Le sessioni Realtime hanno una durata massima lato OpenAI: quel limite
    // (o un riavvio del motore) chiude il socket in modo pulito, senza evento
    // "error". Senza questo handler la sessione resterebbe nella mappa della
    // stanza come zombie: appendAudio diventerebbe un no-op silenzioso e la
    // traduzione smetterebbe di funzionare senza alcun avviso. Segnalando
    // l'errore, la stanza la scarta e la prossima pressione PTT ne crea una
    // nuova.
    let closedByUs = false;
    ws.on("close", () => {
      if (!closedByUs) {
        callbacks.onError(new Error("sessione realtime chiusa dal motore"));
      }
    });

    let buffered = false;

    return {
      sourceLang,
      targetLang,

      setSpeaker(speakerId: string) {
        // Cambio di parlante: azzera la baseline del dedup, perché la stessa
        // frase detta da un'altra persona è legittima e non va scartata.
        if (speakerId !== currentSpeaker) dedup.reset();
        currentSpeaker = speakerId;
      },

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
        closedByUs = true;
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
