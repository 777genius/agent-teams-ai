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
  '--disallowed-tools',
  '--verbose',
  '--model',
  '--effort',
  '--teammate-mode',
  '--resume',
  '-r',
  '--settings',
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
  return scanUserFlags(raw).flags;
}

/**
 * Returns the option that needs a value but ends the args with none (`-n`, `-pn`,
 * `--model`). Appended args would then supply that value, for example a
 * `--settings` flag the app adds after them.
 */
export function findOptionMissingValue(raw: string): string | undefined {
  return scanUserFlags(raw).missingValue;
}

function scanUserFlags(raw: string): { flags: string[]; missingValue?: string } {
  const tokens = parseCliArgs(raw);
  const flags: string[] = [];
  let missingValue: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('-')) continue;
    if (/^-[A-Za-z]/.test(token)) {
      const shortFlags = expandShortFlagToken(token);
      flags.push(...shortFlags);
      // `-n NAME` or `-pn NAME`: when the token ends with an option that requires a
      // value, the CLI reads the next token as that value, even if it starts with `-`.
      const last = shortFlags[shortFlags.length - 1];
      const wholeToken = `-${shortFlags.map((flag) => flag.slice(1)).join('')}`;
      if (token === wholeToken && OPTIONS_WITH_REQUIRED_VALUE.has(last)) {
        if (i === tokens.length - 1) missingValue = last;
        i++;
      }
      continue;
    }
    // Normalize the `--flag=value` form to the bare flag name so protected-flag
    // checks (PROTECTED_CLI_FLAGS.has(...)) cannot be bypassed by appending
    // `=value` (e.g. `--mcp-config=/evil`, `--dangerously-skip-permissions=1`).
    // parseCliArgs splits only on whitespace/quotes, so `--flag=value` arrives
    // as a single token and would otherwise miss an exact-match blocklist.
    const equalsIndex = token.indexOf('=');
    flags.push(equalsIndex === -1 ? token : token.slice(0, equalsIndex));
    // `--append-system-prompt "-review it"`: the CLI reads the next token as the
    // value of an option that requires one, even if it starts with `-`.
    if (equalsIndex === -1 && OPTIONS_WITH_REQUIRED_VALUE.has(token)) {
      if (i === tokens.length - 1) missingValue = token;
      i++;
    }
  }
  return { flags, missingValue };
}

/** Short `claude` options that take no value, so a cluster like `-pr` goes on to `-r`. */
const SHORT_FLAGS_WITHOUT_VALUE = new Set(['c', 'h', 'p', 'v']);

/**
 * `claude --help` options shown with a required `<value>`, plus `--max-turns`, which the
 * CLI accepts with a required value but leaves out of `--help`.
 */
const OPTIONS_WITH_REQUIRED_VALUE = new Set([
  '--add-dir',
  '--agent',
  '--agents',
  '--allowedTools',
  '--allowed-tools',
  '--append-system-prompt',
  '--autocompact',
  '--betas',
  '--debug-file',
  '--disallowedTools',
  '--disallowed-tools',
  '--effort',
  '--environment',
  '--fallback-model',
  '--file',
  '--input-format',
  '--json-schema',
  '--max-budget-usd',
  '--max-turns',
  '--mcp-config',
  '--model',
  '-n',
  '--name',
  '--output-format',
  '--permission-mode',
  '--permission-prompts',
  '--plugin-dir',
  '--plugin-url',
  '--remote-control-session-name-prefix',
  '--session-id',
  '--setting-sources',
  '--settings',
  '--system-prompt',
  '--system-prompt-snapshot',
  '--tools',
]);

/**
 * Splits a short-option token the way the CLI reads it, so protected checks see
 * `-r` in `-rabc`, `-r=abc` and `-pr`. A non-letter after a no-value option stays
 * as its own flag (`-p1` gives `-p`, `-1`), so validation still reports it.
 */
function expandShortFlagToken(token: string): string[] {
  const flags: string[] = [];
  const letters = token.slice(1);
  for (let i = 0; i < letters.length; i++) {
    const ch = letters[i];
    if (!/[A-Za-z]/.test(ch)) {
      flags.push(`-${letters.slice(i)}`);
      break;
    }
    flags.push(`-${ch}`);
    if (!SHORT_FLAGS_WITHOUT_VALUE.has(ch)) break;
  }
  return flags;
}
