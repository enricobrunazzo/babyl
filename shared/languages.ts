/**
 * Nomi inglesi delle lingue supportate, per i prompt del motore di traduzione:
 * "Italian" è più robusto di un codice raw come "it-IT" per un modello LLM.
 * L'elenco rispecchia `web/src/lib/languages.ts` (che resta separato perché
 * porta anche nome nativo e bandiera, dettagli solo di UI).
 */
const LANGUAGE_NAMES: Record<string, string> = {
  it: "Italian",
  en: "English",
  de: "German",
  fr: "French",
  es: "Spanish",
  pt: "Portuguese",
  nl: "Dutch",
  pl: "Polish",
  ru: "Russian",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  ar: "Arabic",
  hi: "Hindi",
  hr: "Croatian",
};

/**
 * Nome inglese della lingua dal codice BCP-47 (anche con regione: "it-IT" →
 * "Italian"). Se il codice non è tra le lingue note, torna il codice stesso.
 */
export function languagePromptName(code: string): string {
  const base = code.toLowerCase().split("-")[0];
  return LANGUAGE_NAMES[base] ?? code;
}
