export interface Language {
  code: string;
  /** Nome nella lingua stessa, come da prassi dei selettori lingua. */
  nativeName: string;
  flag: string;
}

export const LANGUAGES: Language[] = [
  { code: "it", nativeName: "Italiano", flag: "🇮🇹" },
  { code: "en", nativeName: "English", flag: "🇬🇧" },
  { code: "de", nativeName: "Deutsch", flag: "🇩🇪" },
  { code: "fr", nativeName: "Français", flag: "🇫🇷" },
  { code: "es", nativeName: "Español", flag: "🇪🇸" },
  { code: "pt", nativeName: "Português", flag: "🇵🇹" },
  { code: "nl", nativeName: "Nederlands", flag: "🇳🇱" },
  { code: "pl", nativeName: "Polski", flag: "🇵🇱" },
  { code: "ru", nativeName: "Русский", flag: "🇷🇺" },
  { code: "zh", nativeName: "中文", flag: "🇨🇳" },
  { code: "ja", nativeName: "日本語", flag: "🇯🇵" },
  { code: "ko", nativeName: "한국어", flag: "🇰🇷" },
  { code: "ar", nativeName: "العربية", flag: "🇸🇦" },
  { code: "hi", nativeName: "हिन्दी", flag: "🇮🇳" },
];

/**
 * Rilevamento lingua da navigator.language (es. "it-IT" → "it"),
 * usato per auto-compilare il selettore in onboarding.
 */
export function detectLanguage(): string {
  const base = (navigator.language || "en").toLowerCase().split("-")[0];
  return LANGUAGES.some((l) => l.code === base) ? base : "en";
}

export function languageByCode(code: string): Language | undefined {
  return LANGUAGES.find((l) => l.code === code);
}
