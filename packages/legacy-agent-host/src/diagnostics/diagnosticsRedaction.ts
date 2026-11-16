/**
 * Secret redaction and length bounding for member diagnostics strings.
 *
 * The member dialog and the HTTP member diagnostics route project the same raw
 * evidence (process command lines, spawn errors, runtime diagnostics). The HTTP
 * port is unauthenticated and its payloads are persisted by external monitors,
 * so both surfaces must bound and redact through this one implementation.
 */

export const MAX_DIAGNOSTIC_STRING_LENGTH = 500;

const SECRET_FLAG_PATTERN =
  /(--(?:api-key|token|password|secret|authorization|auth-token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_VALUE_PATTERNS: [RegExp, string][] = [
  [/\bsk-\S{12,}\b/gi, '[redacted]'],
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted]'],
];
const SECRET_ENV_KEY_PARTS = [
  'API_KEY',
  'AUTH_TOKEN',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'AUTHORIZATION',
];

export function boundedDiagnosticString(
  value: string | undefined,
  maxLength = MAX_DIAGNOSTIC_STRING_LENGTH
): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  const redacted = redactDiagnosticEnvAssignments(
    SECRET_VALUE_PATTERNS.reduce(
      (current, [pattern, replacement]) => current.replace(pattern, replacement),
      trimmed.replace(SECRET_FLAG_PATTERN, '$1[redacted]')
    )
  );
  return redacted.length > maxLength
    ? `${redacted.slice(0, Math.max(0, maxLength - 3))}...`
    : redacted;
}

function redactDiagnosticEnvAssignments(value: string): string {
  return value.replace(/\b[A-Z0-9_]+\s*=\s*("[^"]*"|'[^']*'|\S+)/gi, (assignment) => {
    const separatorIndex = assignment.indexOf('=');
    const key = assignment.slice(0, separatorIndex).trim().toUpperCase();
    return SECRET_ENV_KEY_PARTS.some((part) => key.includes(part)) ? '[redacted]' : assignment;
  });
}
