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

/**
 * Call once ConfigManager is initialised to sync the opt-in flag.
 * Also call whenever the config changes (e.g. user toggles telemetry in Settings).
 */
export function syncTelemetryFlag(enabled: boolean): void {
  telemetryAllowed = enabled;
}

// ---------------------------------------------------------------------------
// Lazy Sentry import — safe in non-Electron environments
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Sentry: any = null;
let initialized = false;

const dsn = process.env.SENTRY_DSN;

if (isValidDsn(dsn)) {
  try {
    // Dynamic import would be cleaner but top-level await is not available
    // in all contexts. require() is synchronous and works in both Electron
    // and Node.js — it simply throws in standalone mode where the electron
    // module is not resolvable.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Sentry = require('@sentry/electron/main');
    Sentry.init({
      dsn,
      release: SENTRY_RELEASE,
      environment: SENTRY_ENVIRONMENT,
      tracesSampleRate: TRACES_SAMPLE_RATE,
      sendDefaultPii: false,

      beforeSend(event: unknown) {
        return telemetryAllowed ? event : null;
      },
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
  Sentry.addBreadcrumb({ category, message, data, level: 'info' });
}

/**
 * Wrap a synchronous or async function in a Sentry performance span.
 * Returns the function's return value transparently.
 */
export function startMainSpan<T>(name: string, op: string, fn: () => T): T {
  if (!initialized) return fn();
  return Sentry.startSpan({ name, op }, fn);
}
