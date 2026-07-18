import type { RuntimeFailureReasonCode, RuntimeFailureSignal } from '../../contracts';

export type RuntimeFailureRetryDisposition =
  | 'observe_only'
  | 'retry_transient'
  | 'retry_at_reset'
  | 'manual';

export interface RuntimeFailureClassification {
  reasonCode: RuntimeFailureReasonCode;
  disposition: RuntimeFailureRetryDisposition;
  normalizedDetail: string;
  statusCode?: number;
  retryAt?: string;
  retryAfterMs?: number;
  actionRequired: boolean;
}

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\bauthorization:\s*bearer\s+[^'"\s]+/gi, '[redacted]'],
  [/\bsk-[A-Z0-9_-]{12,}\b/gi, '[redacted]'],
  [/\b[A-Z0-9_-]*api[_-]?key[A-Z0-9_-]*[=:]\s*['"]?[^'"\s]+/gi, '[redacted]'],
  [
    /\b[A-Z0-9_]*(?:AUTH_TOKEN|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*[=:]\s*['"]?[^'"\s]+/gi,
    '[redacted]',
  ],
] as const;

const SENSITIVE_ASSIGNMENT_PATTERN =
  /(["']?[A-Z][A-Z0-9_-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi;
const SENSITIVE_ASSIGNMENT_KEYS = new Set([
  'apikey',
  'authorization',
  'authtoken',
  'accesstoken',
  'secret',
  'password',
]);

const TRANSIENT_SERVER_STATUSES = new Set([500, 502, 503, 504, 529]);
const TERMINAL_CLIENT_STATUSES = new Set([400, 404, 413, 422]);

function containsAny(value: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => value.includes(token));
}

export function normalizeRuntimeFailureDetail(detail: string): string {
  const patternRedacted = SECRET_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    detail
  );
  const redacted = patternRedacted.replace(
    SENSITIVE_ASSIGNMENT_PATTERN,
    (match, prefix: string) => {
      const key = prefix
        .split(/\s*[:=]/u, 1)[0]
        ?.replace(/[^a-z0-9]/giu, '')
        .toLowerCase();
      return key && SENSITIVE_ASSIGNMENT_KEYS.has(key) ? `${prefix}[redacted]` : match;
    }
  );
  return redacted.replace(/\s+/g, ' ').trim().slice(0, 8_192);
}

export function extractRuntimeFailureStatusCode(
  detail: string,
  explicitStatusCode?: number
): number | undefined {
  if (
    typeof explicitStatusCode === 'number' &&
    Number.isInteger(explicitStatusCode) &&
    explicitStatusCode >= 100 &&
    explicitStatusCode <= 599
  ) {
    return explicitStatusCode;
  }
  const match =
    /\bAPI\s*Error:\s*(?:API\s*Error:\s*)?(\d{3})\b/i.exec(detail) ??
    /["']?(?:status|status_code)["']?\s*[:=]\s*["']?(\d{3})\b/i.exec(detail);
  return match?.[1] ? Number(match[1]) : undefined;
}

function resolveRetryAt(signal: RuntimeFailureSignal): string | undefined {
  const parsedResetAt = Date.parse(signal.resetAt ?? '');
  if (Number.isFinite(parsedResetAt)) {
    return new Date(parsedResetAt).toISOString();
  }
  if (
    typeof signal.retryAfterMs === 'number' &&
    Number.isFinite(signal.retryAfterMs) &&
    signal.retryAfterMs >= 0
  ) {
    const observedAt = Date.parse(signal.observedAt);
    if (Number.isFinite(observedAt)) {
      return new Date(observedAt + signal.retryAfterMs).toISOString();
    }
  }
  return undefined;
}

function result(
  reasonCode: RuntimeFailureReasonCode,
  disposition: RuntimeFailureRetryDisposition,
  normalizedDetail: string,
  options: {
    statusCode?: number;
    retryAt?: string;
    retryAfterMs?: number;
    actionRequired?: boolean;
  } = {}
): RuntimeFailureClassification {
  return {
    reasonCode,
    disposition,
    normalizedDetail,
    ...(options.statusCode ? { statusCode: options.statusCode } : {}),
    ...(options.retryAt ? { retryAt: options.retryAt } : {}),
    ...(options.retryAfterMs != null ? { retryAfterMs: options.retryAfterMs } : {}),
    actionRequired: options.actionRequired === true,
  };
}

export function classifyRuntimeFailure(signal: RuntimeFailureSignal): RuntimeFailureClassification {
  const normalizedDetail = normalizeRuntimeFailureDetail(signal.detail);
  const lower = normalizedDetail.toLowerCase();
  const statusCode = extractRuntimeFailureStatusCode(normalizedDetail, signal.statusCode);
  const providerCode = signal.providerCode?.trim().toLowerCase() ?? '';
  const retryAt = resolveRetryAt(signal);

  if (signal.phase === 'sdk_retrying') {
    return result('backend_error', 'observe_only', normalizedDetail, {
      statusCode,
      retryAt,
      retryAfterMs: signal.retryAfterMs,
    });
  }

  if (
    containsAny(lower, [
      'user aborted',
      'user abort',
      'cancelled by user',
      'canceled by user',
      'apiuseraborterror',
    ])
  ) {
    return result('user_cancelled', 'manual', normalizedDetail, { statusCode });
  }

  if (
    statusCode === 401 ||
    statusCode === 403 ||
    containsAny(lower, [
      'authentication_failed',
      'unauthorized',
      'forbidden',
      'invalid api key',
      'login required',
      'not logged in',
      'missing credential',
      'permission denied',
      'does not have access',
    ])
  ) {
    return result('auth_error', 'manual', normalizedDetail, {
      statusCode,
      actionRequired: true,
    });
  }

  if (
    containsAny(lower, ['enospc', 'no space left on device', 'disk is full', 'filesystem error'])
  ) {
    return result('filesystem_error', 'manual', normalizedDetail, {
      statusCode,
      actionRequired: true,
    });
  }

  if (
    containsAny(lower, [
      'protocol_proof_missing',
      'member_work_sync_report_required',
      'visible reply still required',
      'did not create a visible reply',
    ])
  ) {
    return result('protocol_proof_missing', 'observe_only', normalizedDetail, { statusCode });
  }

  if (statusCode === 429) {
    return result('rate_limited', retryAt ? 'retry_at_reset' : 'manual', normalizedDetail, {
      statusCode,
      retryAt,
      retryAfterMs: signal.retryAfterMs,
      actionRequired: !retryAt,
    });
  }

  if (statusCode === 529 || (statusCode != null && TRANSIENT_SERVER_STATUSES.has(statusCode))) {
    return result(
      statusCode === 529 || statusCode === 503 ? 'provider_overloaded' : 'backend_error',
      'retry_transient',
      normalizedDetail,
      { statusCode, retryAt, retryAfterMs: signal.retryAfterMs }
    );
  }

  if (statusCode === 408) {
    return result('request_timeout', 'retry_transient', normalizedDetail, { statusCode });
  }
  if (statusCode === 409) {
    return result('request_conflict', 'retry_transient', normalizedDetail, { statusCode });
  }

  if (statusCode != null && TERMINAL_CLIENT_STATUSES.has(statusCode)) {
    return result('client_error', 'manual', normalizedDetail, {
      statusCode,
      actionRequired: true,
    });
  }

  if (
    providerCode === 'overloaded_error' ||
    lower.includes('overloaded_error') ||
    lower.includes('temporarily unavailable') ||
    lower.includes('service unavailable')
  ) {
    return result('provider_overloaded', 'retry_transient', normalizedDetail, {
      statusCode,
      retryAt,
      retryAfterMs: signal.retryAfterMs,
    });
  }

  const quotaOrRateLimit =
    providerCode === 'model_cooldown' ||
    containsAny(lower, [
      'rate limit',
      'rate_limited',
      'too many requests',
      'model cooldown',
      'cooling down',
      'quota exceeded',
      'quota exhausted',
      'usage limit',
      'usage exceeded',
      'insufficient credits',
      'capacity exceeded',
      'exhausted your capacity',
    ]);
  if (quotaOrRateLimit) {
    const quotaExhausted = containsAny(lower, [
      'quota exceeded',
      'quota exhausted',
      'usage limit',
      'usage exceeded',
      'insufficient credits',
      'capacity exceeded',
      'exhausted your capacity',
    ]);
    return result(
      quotaExhausted ? 'quota_exhausted' : 'rate_limited',
      retryAt ? 'retry_at_reset' : 'manual',
      normalizedDetail,
      {
        statusCode,
        retryAt,
        retryAfterMs: signal.retryAfterMs,
        actionRequired: !retryAt,
      }
    );
  }

  if (lower.includes('codex native exec timed out')) {
    return result('codex_native_timeout', 'retry_transient', normalizedDetail, { statusCode });
  }

  if (
    containsAny(lower, [
      'econnreset',
      'epipe',
      'etimedout',
      'connection reset',
      'connection refused',
      'network error',
      'fetch failed',
      'unable to connect',
      'connect failed',
    ])
  ) {
    return result('network_error', 'retry_transient', normalizedDetail, { statusCode });
  }

  return result('unknown', 'manual', normalizedDetail, {
    statusCode,
    actionRequired: true,
  });
}
