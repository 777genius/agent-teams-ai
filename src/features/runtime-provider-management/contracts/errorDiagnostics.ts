export const RUNTIME_ERROR_STAGES = [
  'binary_lookup',
  'version_probe',
  'profile_setup',
  'catalog_identity',
  'server_startup',
  'catalog_http',
  'runtime_command',
  'unknown',
] as const;

export interface RuntimeErrorDetails {
  schemaVersion?: 1;
  reportId?: string;
  timestamp?: string;
  appVersion?: string;
  platform?: string;
  arch?: string;
  stage?: (typeof RUNTIME_ERROR_STAGES)[number];
  binaryRole?: 'opencode' | 'orchestrator';
  binarySource?: 'path' | 'app-managed' | 'unknown';
  durationMs?: number;
  timeoutMs?: number;
  timedOut?: boolean;
  signal?: string;
  systemErrorCode?: string;
  httpMethod?: string;
  endpoint?: string;
  httpStatus?: number;
  cause?: string;
}

/** Sanitize before clipping, so a truncated credential cannot evade redaction. */
export function cleanRuntimeDiagnosticText(value: unknown, limit = 4096): string | null {
  if (typeof value !== 'string') return null;
  // Telemetry redaction hides binary paths and report IDs needed for this opt-in report.
  const cleaned = value
    .replace(/\b(?:sk|pk|rk|ghp|gho|github_pat|xoxb|xoxp|ya29)[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,"']+/gi, '[redacted]')
    .replace(
      /((?:authorization|cookie|password|secret|api[-_]?key|[\w-]*token)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[redacted]'
    )
    .replace(/https?:\/\/[^\s<>"']+/gi, (url) => safeRuntimeEndpoint(url) ?? '[url redacted]');
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 15)}...[truncated]` : cleaned;
}

/** Only catalog routes are safe to retain; other path segments can contain credentials. */
export function safeRuntimeEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    const route = ['/provider', '/config/providers', '/config', '/doc', '/global/health'].includes(
      url.pathname
    )
      ? url.pathname
      : '/[path redacted]';
    return `${url.protocol}//${url.host}${route}`;
  } catch {
    return undefined;
  }
}

export function normalizeRuntimeErrorDetails(value: unknown): RuntimeErrorDetails {
  if (!value || typeof value !== 'object') return {};
  const input = value as Record<string, unknown>;
  const output: RuntimeErrorDetails = {};
  if (input.schemaVersion === 1) output.schemaVersion = 1;
  for (const key of [
    'reportId',
    'timestamp',
    'appVersion',
    'platform',
    'arch',
    'signal',
    'systemErrorCode',
    'cause',
  ] as const) {
    const text = cleanRuntimeDiagnosticText(input[key], key === 'cause' ? 1024 : 256);
    if (text) output[key] = text;
  }
  if (RUNTIME_ERROR_STAGES.includes(input.stage as RuntimeErrorDetails['stage'] & string)) {
    output.stage = input.stage as RuntimeErrorDetails['stage'];
  }
  if (input.binaryRole === 'opencode' || input.binaryRole === 'orchestrator')
    output.binaryRole = input.binaryRole;
  if (
    input.binarySource === 'path' ||
    input.binarySource === 'app-managed' ||
    input.binarySource === 'unknown'
  )
    output.binarySource = input.binarySource;
  for (const key of ['durationMs', 'timeoutMs'] as const) {
    if (typeof input[key] === 'number' && Number.isFinite(input[key]) && input[key] >= 0)
      output[key] = Math.round(input[key]);
  }
  if (typeof input.timedOut === 'boolean') output.timedOut = input.timedOut;
  if (
    Number.isInteger(input.httpStatus) &&
    Number(input.httpStatus) >= 100 &&
    Number(input.httpStatus) <= 599
  )
    output.httpStatus = Number(input.httpStatus);
  if (
    typeof input.httpMethod === 'string' &&
    /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(input.httpMethod)
  )
    output.httpMethod = input.httpMethod;
  const endpoint = safeRuntimeEndpoint(input.endpoint);
  if (endpoint) output.endpoint = endpoint;
  return output;
}

export function runtimeErrorDetailRows(value: RuntimeErrorDetails): [string, string][] {
  const details = normalizeRuntimeErrorDetails(value);
  return Object.entries(details).map(([key, entry]) => [key, String(entry)]);
}
