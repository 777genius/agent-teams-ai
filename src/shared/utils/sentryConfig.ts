/**
 * Shared Sentry configuration constants.
 *
 * Used by both main and renderer process init modules.
 * Does NOT resolve DSN — each process does that with its own env access
 * (main: process.env, renderer: import.meta.env).
 */

// eslint-disable-next-line @typescript-eslint/naming-convention -- Vite `define` injects this global
declare const __APP_VERSION__: string;

/** Release identifier injected at build time via Vite `define`. */
export const SENTRY_RELEASE =
  typeof __APP_VERSION__ === 'string' ? `claude-agent-teams-ui@${__APP_VERSION__}` : undefined;

/** Environment derived from Node/Vite mode. */
export const SENTRY_ENVIRONMENT =
  process.env.NODE_ENV === 'production' ? 'production' : 'development';

/** Performance trace sample rate (production: 10%, dev: 100%). */
export const TRACES_SAMPLE_RATE = process.env.NODE_ENV === 'production' ? 0.1 : 1.0;

/** Validate that a string looks like a Sentry DSN. */
export function isValidDsn(dsn: string | undefined): dsn is string {
  return typeof dsn === 'string' && dsn.length > 0 && dsn.startsWith('https://');
}
