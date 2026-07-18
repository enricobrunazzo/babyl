/**
 * Impostazioni di default regolabili a runtime dal pannello admin, persistite
 * nel DB (tabella `setting`). Senza DB (token admin assente) restano i valori
 * d'ambiente/di default. Fonte unica di verità per la tempistica delle nuove
 * stanze e degli eventi.
 */
import type { Db } from "./db.ts";
import {
  TRANSLATION_TIMINGS,
  type TranslationTiming,
} from "../../shared/protocol.ts";

export interface AppSettings {
  /** Tempistica delle nuove stanze di conversazione (non-evento). */
  defaultTiming: TranslationTiming;
  /** Tempistica pre-selezionata / di ripiego per i nuovi eventi. */
  eventDefaultTiming: TranslationTiming;
}

function parseTiming(
  value: string | null | undefined,
  fallback: TranslationTiming,
): TranslationTiming {
  if (value === "release") return "consecutive";
  return (TRANSLATION_TIMINGS as readonly string[]).includes(value ?? "")
    ? (value as TranslationTiming)
    : fallback;
}

export class Settings {
  constructor(
    private db: Db | null,
    private envDefaultTiming: TranslationTiming,
  ) {}

  /** Legge le impostazioni correnti (DB se presente, altrimenti default env). */
  get(): AppSettings {
    const defaultTiming = parseTiming(
      this.db?.getSetting("defaultTiming"),
      this.envDefaultTiming,
    );
    const eventDefaultTiming = parseTiming(
      this.db?.getSetting("eventDefaultTiming"),
      defaultTiming,
    );
    return { defaultTiming, eventDefaultTiming };
  }

  /** Aggiorna e persiste le impostazioni fornite; ritorna lo stato risultante. */
  update(patch: Partial<AppSettings>): AppSettings {
    if (this.db) {
      if (patch.defaultTiming !== undefined) {
        this.db.setSetting(
          "defaultTiming",
          parseTiming(patch.defaultTiming, this.envDefaultTiming),
        );
      }
      if (patch.eventDefaultTiming !== undefined) {
        this.db.setSetting(
          "eventDefaultTiming",
          parseTiming(patch.eventDefaultTiming, this.envDefaultTiming),
        );
      }
    }
    return this.get();
  }
}
