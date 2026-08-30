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

const SENSITIVE_ASSIGNMENT_PATTERN = /(["'A-Z0-9_-]+\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi;
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
// Statuses that a later branch already turns into a retryable disposition. A refresh
// failure carrying one of these is an outage of the refresh endpoint, not a dead grant.
const TRANSIENT_RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

const NETWORK_FAILURE_MARKERS = [
  'econnreset',
  'epipe',
  'etimedout',
  'connection reset',
  'connection refused',
  'network error',
  'fetch failed',
  'unable to connect',
  'connect failed',
] as const;

const PROVIDER_OVERLOAD_MARKERS = [
  'overloaded_error',
  'temporarily unavailable',
  'service unavailable',
] as const;

const TRANSIENT_TRANSPORT_MARKERS = [
  ...NETWORK_FAILURE_MARKERS,
  ...PROVIDER_OVERLOAD_MARKERS,
] as const;

// Codex CLI stale-auth signatures: a reused/rotated refresh token or a missing
// `codex login` is never fixed by re-running the same exec, so the delivery loop
// must not retry it. Matched against the raw detail because the secret redactor
// rewrites "token: <word>" sequences, which erases these markers from
// normalizedDetail (e.g. "Failed to refresh token: ..." loses "token:").
const CODEX_TERMINAL_AUTH_MARKERS = [
  'refresh_token_reused',
  'invalid_grant',
  'codex_login',
] as const;

// A bare "failed to refresh token" only reports that the refresh call did not
// succeed; it does not say the grant is dead. Classifying it as terminal auth
// regardless of cause strands the teammate with no recovery job whenever the
// refresh endpoint has a transient outage (e.g. "Failed to refresh token: API
// Error: 503"), so it counts as auth failure only when nothing else in the signal
// points at a retryable transport problem.
const CODEX_REFRESH_FAILURE_MARKERS = ['failed to refresh token'] as const;

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
  const rawLower = signal.detail.toLowerCase();
  // The redactor rewrites "token: <word>" sequences, so "Failed to refresh token: API
  // Error: 503" loses its "API Error:" prefix in normalizedDetail. Fall back to the raw
  // detail so a transient status is not lost; only the number is read from it.
  const statusCode =
    extractRuntimeFailureStatusCode(normalizedDetail, signal.statusCode) ??
    extractRuntimeFailureStatusCode(signal.detail);
  const providerCode = signal.providerCode?.trim().toLowerCase() ?? '';
  const retryAt = resolveRetryAt(signal);
  const hasTransientTransportEvidence =
    (statusCode != null && TRANSIENT_RETRY_STATUSES.has(statusCode)) ||
    providerCode === 'overloaded_error' ||
    containsAny(rawLower, TRANSIENT_TRANSPORT_MARKERS);
  const hasCodexAuthFailureMarker =
    containsAny(rawLower, CODEX_TERMINAL_AUTH_MARKERS) ||
    (!hasTransientTransportEvidence && containsAny(rawLower, CODEX_REFRESH_FAILURE_MARKERS));

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
    ]) ||
    hasCodexAuthFailureMarker
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
    containsAny(lower, PROVIDER_OVERLOAD_MARKERS) ||
    containsAny(rawLower, PROVIDER_OVERLOAD_MARKERS)
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

  // Raw detail is consulted too: redaction of "token: ETIMEDOUT" style sequences would
  // otherwise hide a transport failure behind an `unknown`/manual verdict.
  if (
    containsAny(lower, NETWORK_FAILURE_MARKERS) ||
    containsAny(rawLower, NETWORK_FAILURE_MARKERS)
  ) {
    return result('network_error', 'retry_transient', normalizedDetail, { statusCode });
  }

  return result('unknown', 'manual', normalizedDetail, {
    statusCode,
    actionRequired: true,
  });
}
