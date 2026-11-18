/** Closed, presentation-only marker. It never computes launch authority or reads a clock. */
export const PROVIDER_LAUNCH_AUTHORITY_MARKER_ATTRIBUTE = 'data-provider-launch-authority';
export const PROVIDER_LAUNCH_AUTHORITY_MARKER_LIMIT = 1536;
export const UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER = '{"v":1,"state":"unknown"}';

const PROVIDERS = ['anthropic', 'codex', 'gemini', 'opencode'] as const;
const CHECKS = ['checking', 'failed'] as const;
const OUTCOMES = ['authoritative', 'pending', 'transient_error', 'model_only'] as const;
const ERRORS = ['timeout', 'unavailable', 'runtime_missing', 'partial_response', 'project_missing'] as const;
const VERIFICATION = ['verified', 'unknown', 'offline', 'error'] as const;
const REFRESH = ['idle', 'loading', 'ready', 'error'] as const;
const MODEL_CHECK = ['idle', 'verifying', 'verified'] as const;
const CATALOG = ['ready', 'stale', 'degraded', 'unavailable'] as const;
const ROW_KEYS = [
  'provider', 'check', 'loading', 'supported', 'authenticated', 'teamLaunch',
  'outcome', 'error', 'verification', 'refresh', 'modelCheck', 'catalog',
] as const;

function refuse(): never {
  throw new Error('invalid provider notice marker');
}

function object(value: unknown): object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse();
  return value;
}

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return refuse();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) return refuse();
  return descriptor.value;
}

function count(value: unknown): number {
  if (!Array.isArray(value)) return refuse();
  const length = own(value, 'length');
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 1 || length > 4)
    return refuse();
  return length;
}

function exactKeys(value: unknown, keys: readonly string[]): void {
  const found = Reflect.ownKeys(object(value));
  if (found.length !== keys.length || found.some((key) => typeof key !== 'string' || !keys.includes(key)))
    refuse();
}

function choice(value: unknown, allowed: readonly string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) return refuse();
  return value;
}

function optionalChoice(value: unknown, allowed: readonly string[]): string | null {
  return value == null ? null : choice(value, allowed);
}

function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') return refuse();
  return value;
}

function optionalFlag(value: unknown): boolean | null {
  return value == null ? null : flag(value);
}

function canonical(rows: unknown): string {
  const length = count(rows), seen = new Set<string>();
  const providers: Record<string, string | boolean | null>[] = [];
  for (let index = 0; index < length; index++) {
    const row = own(rows, String(index));
    exactKeys(row, ROW_KEYS);
    const provider = choice(own(row, 'provider'), PROVIDERS);
    if (seen.has(provider)) return refuse();
    seen.add(provider);
    providers.push({
      provider,
      check: choice(own(row, 'check'), CHECKS),
      loading: optionalFlag(own(row, 'loading')),
      supported: optionalFlag(own(row, 'supported')),
      authenticated: optionalFlag(own(row, 'authenticated')),
      teamLaunch: optionalFlag(own(row, 'teamLaunch')),
      outcome: optionalChoice(own(row, 'outcome'), OUTCOMES),
      error: optionalChoice(own(row, 'error'), ERRORS),
      verification: optionalChoice(own(row, 'verification'), VERIFICATION),
      refresh: optionalChoice(own(row, 'refresh'), REFRESH),
      modelCheck: optionalChoice(own(row, 'modelCheck'), MODEL_CHECK),
      catalog: optionalChoice(own(row, 'catalog'), CATALOG),
    });
  }
  const encoded = JSON.stringify({ v: 1, state: 'observed', providers });
  if (encoded.length > PROVIDER_LAUNCH_AUTHORITY_MARKER_LIMIT || !/^[\x20-\x7e]+$/.test(encoded))
    return refuse();
  return encoded;
}

/** Project only already-computed checks and own data from their original DTOs. */
export function createProviderLaunchAuthorityMarker(
  blockers: unknown,
  checks: unknown,
  loading: unknown
): string {
  try {
    const length = count(blockers);
    if (count(checks) !== length) return refuse();
    object(loading);
    const rows: Record<string, string | boolean | null>[] = [];
    for (let index = 0; index < length; index++) {
      const blocker = object(own(blockers, String(index)));
      const check = object(own(checks, String(index)));
      const provider = choice(own(blocker, 'providerId'), PROVIDERS);
      if (own(check, 'providerId') !== provider) return refuse();
      const presentation = choice(own(check, 'status'), CHECKS);
      const status = own(blocker, 'providerStatus');
      if (status !== null) {
        object(status);
        if (own(status, 'providerId') !== provider) return refuse();
      }
      const capabilities = status === null ? null : object(own(status, 'capabilities'));
      const catalog = status === null ? null : own(status, 'modelCatalog');
      if (catalog != null) {
        object(catalog);
        if (own(catalog, 'providerId') !== provider || own(catalog, 'schemaVersion') !== 1)
          return refuse();
      }
      rows.push({
        provider,
        check: presentation,
        loading: optionalFlag(own(loading, provider)),
        supported: status === null ? null : flag(own(status, 'supported')),
        authenticated: status === null ? null : flag(own(status, 'authenticated')),
        teamLaunch: capabilities === null ? null : flag(own(capabilities, 'teamLaunch')),
        outcome: status === null ? null : optionalChoice(own(status, 'statusCheckOutcome'), OUTCOMES),
        error: status === null ? null : optionalChoice(own(status, 'statusCheckErrorCode'), ERRORS),
        verification: status === null ? null : choice(own(status, 'verificationState'), VERIFICATION),
        refresh: status === null ? null : optionalChoice(own(status, 'modelCatalogRefreshState'), REFRESH),
        modelCheck: status === null ? null : optionalChoice(own(status, 'modelVerificationState'), MODEL_CHECK),
        catalog: catalog == null ? null : choice(own(catalog, 'status'), CATALOG),
      });
    }
    return canonical(rows);
  } catch {
    return UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER;
  }
}

/** Reject absent, malformed, noncanonical or oversized transport data without echoing it. */
export function readProviderLaunchAuthorityMarker(value: unknown): string {
  try {
    if (typeof value !== 'string' || value.length > PROVIDER_LAUNCH_AUTHORITY_MARKER_LIMIT ||
      !/^[\x20-\x7e]+$/.test(value)) return UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER;
    if (value === UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER) return value;
    const parsed: unknown = JSON.parse(value);
    exactKeys(parsed, ['v', 'state', 'providers']);
    if (own(parsed, 'v') !== 1 || own(parsed, 'state') !== 'observed') return refuse();
    const encoded = canonical(own(parsed, 'providers'));
    return encoded === value ? encoded : UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER;
  } catch {
    return UNKNOWN_PROVIDER_LAUNCH_AUTHORITY_MARKER;
  }
}
