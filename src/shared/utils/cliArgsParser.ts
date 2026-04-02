/**
 * CLI argument parsing and validation utilities.
 *
 * Used for:
 * - Parsing user-entered custom CLI args into an array for spawn()
 * - Extracting known flags from `claude --help` output for validation
 * - Identifying which user-entered flags are invalid
 */

/** Результат валидации пользовательских аргументов через `claude --help`. */
export interface CliArgsValidationResult {
  valid: boolean;
  invalidFlags?: string[];
}

/**
 * Набор CLI-флагов, которые управляются приложением автоматически.
 * Если пользователь указал один из них в custom args — Validate покажет warning.
 */
export const PROTECTED_CLI_FLAGS = new Set([
  '--input-format',
  '--output-format',
  '--setting-sources',
  '--mcp-config',
  '--disallowedTools',
  '--verbose',
  '--model',
  '--effort',
  '--resume',
  '--permission-mode',
  '--permission-prompt-tool',
  '--dangerously-skip-permissions',
]);

/**
 * Shell-like split: разбивает строку на токены, учитывая кавычки.
 *
 * - Поддерживает одинарные и двойные кавычки
 * - НЕ обрабатывает backslash-escaping (не нужно для CLI-флагов)
 * - Множественные пробелы/табы игнорируются
 *
 * @example
 * parseCliArgs('--verbose --max-turns 5')       // ['--verbose', '--max-turns', '5']
 * parseCliArgs('--message "hello world"')        // ['--message', 'hello world']
 * parseCliArgs("--message 'it works'")           // ['--message', 'it works']
 * parseCliArgs(undefined)                        // []
 */
export function parseCliArgs(raw: string | undefined): string[] {
  if (!raw) return [];

  const result: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let hasQuote = false;

  for (const ch of raw) {
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      hasQuote = true;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      hasQuote = true;
      continue;
    }
    if ((ch === ' ' || ch === '\t') && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0 || hasQuote) {
        result.push(current);
        current = '';
        hasQuote = false;
      }
      continue;
    }
    current += ch;
  }

  if (current.length > 0 || hasQuote) {
    result.push(current);
  }

  return result;
}

/**
 * Извлекает все CLI-флаги из вывода `claude --help`.
 *
 * Парсит:
 * - Long flags: `--model`, `--max-turns`, `--dangerously-skip-permissions`
 * - Short flags: `-p`, `-w`, `-m`
 *
 * Regex осторожно выбирает только флаги в "позиции флага" (после пробела/начала строки),
 * чтобы не ловить дефисы из обычного текста.
 */
export function extractFlagsFromHelp(helpOutput: string): Set<string> {
  const flags = new Set<string>();

  // Long flags: --word-word-word (после пробела, начала строки, или запятой)
  const longFlagRegex = /(?:^|[\s,])(-{2}[a-zA-Z][a-zA-Z0-9-]*)/gm;
  let match: RegExpExecArray | null;
  while ((match = longFlagRegex.exec(helpOutput)) !== null) {
    flags.add(match[1]);
  }

  // Short flags: -X (одна буква, после пробела/начала строки/запятой)
  const shortFlagRegex = /(?:^|[\s,])(-[a-zA-Z])\b/gm;
  while ((match = shortFlagRegex.exec(helpOutput)) !== null) {
    flags.add(match[1]);
  }

  return flags;
}

/**
 * Извлекает только флаги (начинающиеся с `-`) из строки пользовательских аргументов.
 *
 * @example
 * extractUserFlags('--verbose --max-turns 5 foo')  // ['--verbose', '--max-turns']
 * extractUserFlags('-p -w')                         // ['-p', '-w']
 * extractUserFlags('')                              // []
 */
export function extractUserFlags(raw: string): string[] {
  const tokens = parseCliArgs(raw);
  return tokens.filter((token) => token.startsWith('-'));
}
