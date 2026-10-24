import { boundedDiagnosticString } from './diagnosticsRedaction';

const ESCAPE_CHARACTER = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ESCAPE_CHARACTER}\\[[0-?]*[ -/]*[@-~]`, 'g');
const SENSITIVE_DUMP_PATTERNS = [
  /\b(?:env|environment|auth|credential|credentials|config|configuration)\b["']?\s*[:=]\s*[{[]/i,
  /\b(?:environment|credentials?|configuration|auth|config)\s+dump\b/i,
];

/** Sanitizes runtime evidence for both main-process and renderer diagnostic boundaries. */
export function sanitizeRuntimeDiagnosticText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Suppress entire dumps, including arbitrary non-secret config/environment fields.
  if (SENSITIVE_DUMP_PATTERNS.some((pattern) => pattern.test(value))) {
    return boundedDiagnosticString('[configuration/auth/environment dump hidden]', limit);
  }
  const sanitized = value
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(
      /(---\s*JSONC? Input\s*---)[\s\S]*?(?=---\s*(?:Errors|End)\s*---|$)/gi,
      '$1\n[configuration contents hidden]\n'
    )
    .replace(/^[\t ]*(Line\s+\d+\s*:)[^\r\n]*/gim, '$1 [configuration source hidden]')
    .replace(
      /\b[A-Z][A-Z0-9_]*\s*=\s*("[^"]*"|'[^']*'|[^\s,;}]+)/g,
      '[environment assignment hidden]'
    )
    .replace(/\b((?:proxy-)?authorization\s*["']?\s*:\s*["']?)[^\r\n]+/gi, '$1[redacted]')
    .replace(/\b((?:api[_-]?key)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(
      /\b((?:access|refresh|auth)[_-]?token["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      '$1[redacted]'
    )
    .replace(
      /\b((?:token|secret|password|cookie)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      '$1[redacted]'
    )
    .replace(/\b((?:bearer|basic)\s+)[^\s"',;]+/gi, '$1[redacted]')
    .replace(/\b(?:or-|AIza)[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/\b(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, '$1[query hidden]');
  const lines = sanitized
    .split(/\r?\n/)
    .map((line) => boundedDiagnosticString(line, limit) ?? '')
    .join('\n')
    .trim();
  if (!lines) return undefined;
  return lines.length > limit ? `${lines.slice(0, Math.max(0, limit - 3))}...` : lines;
}
