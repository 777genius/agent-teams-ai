import type {
  RuntimeProviderManagementModelTestResponse,
  RuntimeProviderModelTestResultDto,
} from '@features/runtime-provider-management/contracts';

// The command includes profile/inventory setup, host readiness, OpenCode's
// two-minute execution probe, and a bounded post-action refresh. Keep one
// finite desktop watchdog around the complete lifecycle rather than only the
// inner probe.
const RUNTIME_MODEL_OPERATION_MAX_DURATION_MS = 210_000;
const MODEL_PROBE_TRANSPORT_GRACE_MS = 30_000;
const MODEL_TEST_DIAGNOSTIC_ITEM_LIMIT = 1_200;
const MODEL_TEST_DIAGNOSTIC_MAX_ITEMS = 32;
const RUNTIME_PROVIDER_URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const ESCAPE_CHARACTER = String.fromCharCode(27);
const BELL_CHARACTER = String.fromCharCode(7);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ESCAPE_CHARACTER}\\[[0-?]*[ -/]*[@-~]`, 'g');
const OSC_ESCAPE_PATTERN = new RegExp(
  `${ESCAPE_CHARACTER}\\][\\s\\S]*?(?:${BELL_CHARACTER}|${ESCAPE_CHARACTER}\\\\)`,
  'g'
);

export const RUNTIME_PROVIDER_MODEL_PROBE_COMMAND_TIMEOUT_MS =
  RUNTIME_MODEL_OPERATION_MAX_DURATION_MS + MODEL_PROBE_TRANSPORT_GRACE_MS;

/** Removes terminal controls, credentials, and unsafe endpoint URL portions. */
export function sanitizeRuntimeProviderText(value: string): string {
  return redactSensitiveText(stripTerminalFormatting(value)).replace(
    RUNTIME_PROVIDER_URL_PATTERN,
    (url) => sanitizeRuntimeProviderEndpoint(url) ?? '[invalid endpoint hidden]'
  );
}

export function stripTerminalFormatting(value: string): string {
  return value.replace(OSC_ESCAPE_PATTERN, '').replace(ANSI_ESCAPE_PATTERN, '');
}

/**
 * Runtime result metadata is optional so packaged desktop builds stay
 * compatible with older orchestrators. Normalize it at the process boundary:
 * an endpoint is useful in a failure report, but never its credentials, query,
 * or fragment.
 */
export function sanitizeRuntimeProviderModelTestResponse(
  response: RuntimeProviderManagementModelTestResponse
): RuntimeProviderManagementModelTestResponse {
  const result = response.result;
  if (!result) {
    return response;
  }

  const normalizedResult: RuntimeProviderModelTestResultDto = { ...result };
  normalizedResult.diagnostics = sanitizeModelTestDiagnostics(result.diagnostics);
  if (result.failureCode !== undefined) {
    normalizedResult.failureCode = sanitizeModelTestFailureCode(result.failureCode);
  }
  if (result.effectiveBaseUrl !== undefined) {
    normalizedResult.effectiveBaseUrl = sanitizeRuntimeProviderEndpoint(result.effectiveBaseUrl);
  }
  if (result.providerSource !== undefined) {
    normalizedResult.providerSource = sanitizeModelTestProviderSource(result.providerSource);
  }
  return { ...response, result: normalizedResult };
}

function sanitizeModelTestDiagnostics(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .slice(0, MODEL_TEST_DIAGNOSTIC_MAX_ITEMS)
    .map((entry) => {
      const sanitized = sanitizeRuntimeProviderText(entry);
      return sanitized.length > MODEL_TEST_DIAGNOSTIC_ITEM_LIMIT
        ? `${sanitized.slice(0, MODEL_TEST_DIAGNOSTIC_ITEM_LIMIT).trimEnd()}...`
        : sanitized;
    });
}

function sanitizeModelTestFailureCode(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized) ? normalized : null;
}

function sanitizeRuntimeProviderEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    const endpoint = new URL(value.trim());
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
      return null;
    }
    endpoint.username = '';
    endpoint.password = '';
    endpoint.search = '';
    endpoint.hash = '';
    return endpoint.toString();
  } catch {
    return null;
  }
}

function sanitizeModelTestProviderSource(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ['env', 'config', 'custom', 'api'].includes(normalized) ? normalized : null;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, 'sk-...redacted')
    .replace(/\b(or-[A-Za-z0-9_-]{12,})\b/g, 'or-...redacted')
    .replace(/\b(AIza[A-Za-z0-9_-]{20,})\b/g, 'AIza...redacted')
    .replace(
      /\b([a-z0-9_.-]*(?:api[-_]?key|(?:access|auth)[-_]?token|token|secret|password|[-_]key)["'\s:=]+)([a-z0-9._~+/=-]{12,})/gi,
      '$1...redacted'
    )
    .replace(/\b(key["'\s:=]+)([a-z0-9._~+/=-]{12,})/gi, '$1...redacted')
    .replace(/\b(bearer\s+)([a-z0-9._~+/=-]{12,})/gi, '$1...redacted');
}
