/**
 * Sentry initialisation for the Electron **main** process.
 *
 * Must be imported at the very top of `src/main/index.ts` (and `standalone.ts`)
 * so that Sentry captures errors from the earliest point possible.
 *
 * When `SENTRY_DSN` is not set (dev / self-builds), everything is a no-op.
 *
 * The @sentry/electron/main import is lazy so this module can be safely
 * loaded in standalone (non-Electron) mode without crashing.
 */

import {
  type AgentTeamsIdentitySource,
  ensureAgentTeamsClientIdentity,
  getSentryAnonymousUserId,
} from '@main/services/identity/AgentTeamsIdentityStore';
import {
  isValidDsn,
  SENTRY_ENVIRONMENT,
  SENTRY_RELEASE,
  TRACES_SAMPLE_RATE,
} from '@shared/utils/sentryConfig';

// ---------------------------------------------------------------------------
// Telemetry gate
// ---------------------------------------------------------------------------

// Module-level flag that `beforeSend` checks.
// Updated by `syncTelemetryFlag()` once ConfigManager is ready.
// Defaults to `true` so early crash reports are NOT silently dropped;
// if the user later turns telemetry off, the flag flips to `false`.
let telemetryAllowed = true;
let telemetryIdentitySyncToken = 0;

export function getSafeSentryTelemetryTags(
  identitySource: AgentTeamsIdentitySource
): Record<string, string> {
  return {
    platform: process.platform,
    arch: process.arch,
    app_version: SENTRY_RELEASE ?? 'unknown',
    identity_source: identitySource,
  };
}

/**
 * Call once ConfigManager is initialised to sync the opt-in flag.
 * Also call whenever the config changes (e.g. user toggles telemetry in Settings).
 */
export function syncTelemetryFlag(enabled: boolean): void {
  telemetryAllowed = enabled;
  void syncTelemetryIdentity();
}

export function filterSentryEventForTelemetry(event: unknown): unknown {
  return telemetryAllowed ? event : null;
}

// ---------------------------------------------------------------------------
// Lazy Sentry import — safe in non-Electron environments
// ---------------------------------------------------------------------------

interface SentryMainApi {
  init?: (options: SentryInitOptions) => void;
  setUser?: (user: { id: string } | null) => void;
  setTags?: (tags: Record<string, string>) => void;
  addBreadcrumb?: (breadcrumb: {
    category: string;
    message: string;
    data?: Record<string, unknown>;
    level: 'info';
  }) => void;
  startSpan?: <T>(context: { name: string; op: string }, callback: () => T) => T;
}

interface SentryInitOptions {
  dsn: string;
  release: string | undefined;
  environment: string;
  tracesSampleRate: number;
  sendDefaultPii: false;
  beforeSend: (event: unknown) => unknown;
  beforeSendTransaction: (event: unknown) => unknown;
}

let Sentry: SentryMainApi | null = null;
let initialized = false;

export function setMainSentryApiForTesting(sentryApi: SentryMainApi): void {
  if (process.env.NODE_ENV !== 'test') return;
  Sentry = sentryApi;
  initialized = true;
}

function clearSentryUser(): void {
  if (!initialized || !Sentry) return;
  Sentry.setUser?.(null);
}

async function syncTelemetryIdentity(): Promise<void> {
  const syncToken = ++telemetryIdentitySyncToken;
  if (!initialized || !Sentry) {
    return;
  }

  if (!telemetryAllowed) {
    clearSentryUser();
    return;
  }

  try {
    const identity = await ensureAgentTeamsClientIdentity();
    if (syncToken !== telemetryIdentitySyncToken || !telemetryAllowed) {
      return;
    }

    Sentry.setUser?.({ id: getSentryAnonymousUserId(identity.clientId) });
    Sentry.setTags?.(getSafeSentryTelemetryTags(identity.source));
  } catch {
    if (syncToken === telemetryIdentitySyncToken) {
      clearSentryUser();
    }
  }
}

const dsn = process.env.SENTRY_DSN;

if (isValidDsn(dsn)) {
  try {
    // Dynamic import would be cleaner but top-level await is not available
    // in all contexts. require() is synchronous and works in both Electron
    // and Node.js — it simply throws in standalone mode where the electron
    // module is not resolvable.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy optional Electron runtime dependency.
    Sentry = require('@sentry/electron/main') as SentryMainApi;
    Sentry.init?.({
      dsn,
      release: SENTRY_RELEASE,
      environment: SENTRY_ENVIRONMENT,
      tracesSampleRate: TRACES_SAMPLE_RATE,
      sendDefaultPii: false,

      beforeSend: filterSentryEventForTelemetry,
      beforeSendTransaction: filterSentryEventForTelemetry,
    });
    initialized = true;
  } catch {
    // @sentry/electron/main requires Electron runtime — not available in
    // standalone (pure Node.js) mode. All exported helpers are no-ops when
    // initialized is false, so this is safe to swallow.
  }
}

// ---------------------------------------------------------------------------
// Public helpers (no-op when Sentry is not configured)
// ---------------------------------------------------------------------------

/** Record a breadcrumb visible in subsequent error events. */
export function addMainBreadcrumb(
  category: string,
  message: string,
  data?: Record<string, unknown>
): void {
  if (!initialized) return;
  Sentry?.addBreadcrumb?.({ category, message, data, level: 'info' });
}

/**
 * Wrap a synchronous or async function in a Sentry performance span.
 * Returns the function's return value transparently.
 */
export function startMainSpan<T>(name: string, op: string, fn: () => T): T {
  if (!initialized) return fn();
  if (!Sentry?.startSpan) return fn();
  return Sentry.startSpan({ name, op }, fn);
}
