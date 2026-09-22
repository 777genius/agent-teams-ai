/**
 * Agent language configuration utilities.
 * Pure functions — no Electron or DOM dependencies.
 */

export interface AgentLanguageOption {
  readonly value: string;
  readonly label: string;
  readonly flag: string;
}

/** Curated list of language options for agent communication (sorted alphabetically after System). */
export const AGENT_LANGUAGE_OPTIONS: readonly AgentLanguageOption[] = [
  { value: 'system', label: 'System', flag: '\u{1F310}' },
  { value: 'af', label: 'Afrikaans', flag: '\u{1F1FF}\u{1F1E6}' },
  { value: 'am', label: 'Amharic', flag: '\u{1F1EA}\u{1F1F9}' },
  { value: 'ar', label: 'Arabic', flag: '\u{1F1F8}\u{1F1E6}' },
  { value: 'az', label: 'Azerbaijani', flag: '\u{1F1E6}\u{1F1FF}' },
  { value: 'be', label: 'Belarusian', flag: '\u{1F1E7}\u{1F1FE}' },
  { value: 'bg', label: 'Bulgarian', flag: '\u{1F1E7}\u{1F1EC}' },
  { value: 'bn', label: 'Bengali', flag: '\u{1F1E7}\u{1F1E9}' },
  { value: 'bs', label: 'Bosnian', flag: '\u{1F1E7}\u{1F1E6}' },
  { value: 'ca', label: 'Catalan', flag: '\u{1F1EA}\u{1F1F8}' },
  { value: 'cs', label: 'Czech', flag: '\u{1F1E8}\u{1F1FF}' },
  {
    value: 'cy',
    label: 'Welsh',
    flag: '\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}',
  },
  { value: 'da', label: 'Danish', flag: '\u{1F1E9}\u{1F1F0}' },
  { value: 'de', label: 'German', flag: '\u{1F1E9}\u{1F1EA}' },
  { value: 'el', label: 'Greek', flag: '\u{1F1EC}\u{1F1F7}' },
  { value: 'en', label: 'English', flag: '\u{1F1FA}\u{1F1F8}' },
  { value: 'es', label: 'Spanish', flag: '\u{1F1EA}\u{1F1F8}' },
  { value: 'et', label: 'Estonian', flag: '\u{1F1EA}\u{1F1EA}' },
  { value: 'eu', label: 'Basque', flag: '\u{1F1EA}\u{1F1F8}' },
  { value: 'fa', label: 'Persian', flag: '\u{1F1EE}\u{1F1F7}' },
  { value: 'fi', label: 'Finnish', flag: '\u{1F1EB}\u{1F1EE}' },
  { value: 'fil', label: 'Filipino', flag: '\u{1F1F5}\u{1F1ED}' },
  { value: 'fr', label: 'French', flag: '\u{1F1EB}\u{1F1F7}' },
  { value: 'ga', label: 'Irish', flag: '\u{1F1EE}\u{1F1EA}' },
  { value: 'gl', label: 'Galician', flag: '\u{1F1EA}\u{1F1F8}' },
  { value: 'gu', label: 'Gujarati', flag: '\u{1F1EE}\u{1F1F3}' },
  { value: 'he', label: 'Hebrew', flag: '\u{1F1EE}\u{1F1F1}' },
  { value: 'hi', label: 'Hindi', flag: '\u{1F1EE}\u{1F1F3}' },
  { value: 'hr', label: 'Croatian', flag: '\u{1F1ED}\u{1F1F7}' },
  { value: 'hu', label: 'Hungarian', flag: '\u{1F1ED}\u{1F1FA}' },
  { value: 'hy', label: 'Armenian', flag: '\u{1F1E6}\u{1F1F2}' },
  { value: 'id', label: 'Indonesian', flag: '\u{1F1EE}\u{1F1E9}' },
  { value: 'is', label: 'Icelandic', flag: '\u{1F1EE}\u{1F1F8}' },
  { value: 'it', label: 'Italian', flag: '\u{1F1EE}\u{1F1F9}' },
  { value: 'ja', label: 'Japanese', flag: '\u{1F1EF}\u{1F1F5}' },
  { value: 'ka', label: 'Georgian', flag: '\u{1F1EC}\u{1F1EA}' },
  { value: 'kk', label: 'Kazakh', flag: '\u{1F1F0}\u{1F1FF}' },
  { value: 'km', label: 'Khmer', flag: '\u{1F1F0}\u{1F1ED}' },
  { value: 'kn', label: 'Kannada', flag: '\u{1F1EE}\u{1F1F3}' },
  { value: 'ko', label: 'Korean', flag: '\u{1F1F0}\u{1F1F7}' },
  { value: 'lt', label: 'Lithuanian', flag: '\u{1F1F1}\u{1F1F9}' },
  { value: 'lv', label: 'Latvian', flag: '\u{1F1F1}\u{1F1FB}' },
  { value: 'mk', label: 'Macedonian', flag: '\u{1F1F2}\u{1F1F0}' },
  { value: 'ml', label: 'Malayalam', flag: '\u{1F1EE}\u{1F1F3}' },
  { value: 'mn', label: 'Mongolian', flag: '\u{1F1F2}\u{1F1F3}' },
  { value: 'mr', label: 'Marathi', flag: '\u{1F1EE}\u{1F1F3}' },
  { value: 'ms', label: 'Malay', flag: '\u{1F1F2}\u{1F1FE}' },
  { value: 'my', label: 'Burmese', flag: '\u{1F1F2}\u{1F1F2}' },
  { value: 'ne', label: 'Nepali', flag: '\u{1F1F3}\u{1F1F5}' },
  { value: 'nl', label: 'Dutch', flag: '\u{1F1F3}\u{1F1F1}' },
  { value: 'no', label: 'Norwegian', flag: '\u{1F1F3}\u{1F1F4}' },
  { value: 'pa', label: 'Punjabi', flag: '\u{1F1EE}\u{1F1F3}' },
  { value: 'pl', label: 'Polish', flag: '\u{1F1F5}\u{1F1F1}' },
  { value: 'pt', label: 'Portuguese', flag: '\u{1F1E7}\u{1F1F7}' },
  { value: 'ro', label: 'Romanian', flag: '\u{1F1F7}\u{1F1F4}' },
  { value: 'ru', label: 'Russian', flag: '\u{1F1F7}\u{1F1FA}' },
  { value: 'si', label: 'Sinhala', flag: '\u{1F1F1}\u{1F1F0}' },
  { value: 'sk', label: 'Slovak', flag: '\u{1F1F8}\u{1F1F0}' },
  { value: 'sl', label: 'Slovenian', flag: '\u{1F1F8}\u{1F1EE}' },
  { value: 'sq', label: 'Albanian', flag: '\u{1F1E6}\u{1F1F1}' },
  { value: 'sr', label: 'Serbian', flag: '\u{1F1F7}\u{1F1F8}' },
  { value: 'sv', label: 'Swedish', flag: '\u{1F1F8}\u{1F1EA}' },
  { value: 'sw', label: 'Swahili', flag: '\u{1F1F0}\u{1F1EA}' },
  { value: 'ta', label: 'Tamil', flag: '\u{1F1EE}\u{1F1F3}' },
  { value: 'te', label: 'Telugu', flag: '\u{1F1EE}\u{1F1F3}' },
  { value: 'th', label: 'Thai', flag: '\u{1F1F9}\u{1F1ED}' },
  { value: 'tr', label: 'Turkish', flag: '\u{1F1F9}\u{1F1F7}' },
  { value: 'uk', label: 'Ukrainian', flag: '\u{1F1FA}\u{1F1E6}' },
  { value: 'ur', label: 'Urdu', flag: '\u{1F1F5}\u{1F1F0}' },
  { value: 'uz', label: 'Uzbek', flag: '\u{1F1FA}\u{1F1FF}' },
  { value: 'vi', label: 'Vietnamese', flag: '\u{1F1FB}\u{1F1F3}' },
  { value: 'zh', label: 'Chinese', flag: '\u{1F1E8}\u{1F1F3}' },
  { value: 'zu', label: 'Zulu', flag: '\u{1F1FF}\u{1F1E6}' },
] as const;

/**
 * Resolves a language code to a human-readable language name.
 *
 * - `'system'` → resolved from `systemLocale` via `Intl.DisplayNames` (e.g. "English", "Русский")
 * - Known BCP-47 code → human name via `Intl.DisplayNames`
 * - Fallback → returns the code itself
 */
export function resolveLanguageName(code: string, systemLocale?: string): string {
  const effectiveCode = code === 'system' ? extractPrimaryLanguage(systemLocale ?? 'en') : code;

  try {
    const displayNames = new Intl.DisplayNames([effectiveCode], { type: 'language' });
    const name = displayNames.of(effectiveCode);
    if (name) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  } catch {
    // Intl.DisplayNames not available or invalid code — fall through
  }

  // Fallback: check our curated list
  const option = AGENT_LANGUAGE_OPTIONS.find((o) => o.value === effectiveCode);
  return option?.label ?? effectiveCode;
}

/** Extracts primary language subtag from a locale string (e.g. "en-US" → "en"). */
function extractPrimaryLanguage(locale: string): string {
  const dash = locale.indexOf('-');
  return dash > 0 ? locale.slice(0, dash) : locale;
}
