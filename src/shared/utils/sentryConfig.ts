/**
 * Shared Sentry configuration constants.
 *
 * Used by both main and renderer process init modules.
 * Does NOT resolve DSN - each process does that with its own env access
 * (main: process.env, renderer: import.meta.env).
 */

import { APP_RELEASE } from './buildMetadata';

// eslint-disable-next-line @typescript-eslint/naming-convention -- Vite `define` injects this global.
declare const __SENTRY_ENVIRONMENT__: string;

/** Release identifier injected at build time via Vite `define`. */
export const SENTRY_RELEASE = APP_RELEASE;

/** Environment injected at build time because packaged Electron may not retain NODE_ENV. */
export const SENTRY_ENVIRONMENT: 'production' | 'development' =
  typeof __SENTRY_ENVIRONMENT__ === 'string' && __SENTRY_ENVIRONMENT__ === 'production'
    ? 'production'
    : 'development';

/** Performance trace sample rate (production: 10%, dev: 100%). */
export const TRACES_SAMPLE_RATE = SENTRY_ENVIRONMENT === 'production' ? 0.1 : 1.0;

/** Validate that a string looks like a Sentry DSN. */
export function isValidDsn(dsn: string | undefined): dsn is string {
  if (typeof dsn !== 'string' || dsn.length === 0) {
    return false;
  }

  try {
    const parsed = new URL(dsn);
    const projectId = parsed.pathname.split('/').filter(Boolean).at(-1);
    return (
      parsed.protocol === 'https:' &&
      parsed.username.length > 0 &&
      parsed.password.length === 0 &&
      parsed.hostname.length > 0 &&
      /^[0-9]+$/.test(projectId ?? '')
    );
  } catch {
    return false;
  }
}

const REDACTED = '[redacted]';
const MAX_REDACTION_DEPTH = 8;
const SENSITIVE_KEY_PARTS = [
  'token',
  'secret',
  'apikey',
  'api_key',
  'password',
  'credential',
  'authorization',
  'cookie',
  'email',
  'account',
  'clientid',
  'project',
  'repo',
  'path',
  'cwd',
  'teamname',
  'sessionid',
  'taskid',
  'username',
  'user_name',
];

const SENSITIVE_STRING_PATTERNS: [RegExp, string][] = [
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, REDACTED],
  [/\b(?:sk|pk|rk|ghp|gho|github_pat|xoxb|xoxp|ya29)[A-Za-z0-9_-]{12,}\b/g, REDACTED],
  [/\b(?:Bearer|Basic)\s+[A-Z0-9._~+/=-]{8,}/gi, REDACTED],
  [/\/Users\/[^/\s"'`]+(?:\/[^\s"'`]+)*/g, '/Users/[redacted]/[redacted-path]'],
  [/\/home\/[^/\s"'`]+(?:\/[^\s"'`]+)*/g, '/home/[redacted]/[redacted-path]'],
  [/\/Volumes\/[^/\s"'`]+(?:\/[^\s"'`]+)*/g, '/Volumes/[redacted]/[redacted-path]'],
  [/([A-Za-z]:\\Users\\)[^\\\s"'`]+(?:\\[^\\\s"'`]+)*/g, '$1[redacted]\\[redacted-path]'],
];

const UNSAFE_SENTRY_INTEGRATION_NAMES = new Set([
  'AdditionalContext',
  'Breadcrumbs',
  'BrowserSession',
  'ChildProcess',
  'Console',
  'ContextLines',
  'CultureContext',
  'ElectronBreadcrumbs',
  'ElectronContext',
  'ElectronNet',
  'EventLoopBlockRenderer',
  'GpuContext',
  'HttpContext',
  'LocalVariables',
  'NativeNodeFetch',
  'NodeContext',
  'NodeFetch',
  'PreloadInjection',
  'RendererEventLoopBlock',
  'RendererProfiling',
  'Screenshots',
  'SentryMinidump',
  'StartupTracing',
]);

interface SentryIntegrationLike {
  name?: string;
}

export function filterSafeSentryIntegrations<TIntegration extends SentryIntegrationLike>(
  integrations: TIntegration[]
): TIntegration[] {
  return integrations.filter(
    (integration) => !integration.name || !UNSAFE_SENTRY_INTEGRATION_NAMES.has(integration.name)
  );
}

function redactSentryString(value: string): string {
  const redacted = SENSITIVE_STRING_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value
  );
  return redactSentryEnvAssignments(redacted);
}

function isSensitiveSentryKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function redactSentryEnvAssignments(value: string): string {
  return value.replace(/\b[A-Z0-9_]+\s*=\s*("[^"]*"|'[^']*'|\S+)/gi, (match) => {
    const separatorIndex = match.indexOf('=');
    const key = match.slice(0, separatorIndex).trim();
    return isSensitiveSentryKey(key) ? REDACTED : match;
  });
}

function redactSentryValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactSentryString(value);
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  if (depth >= MAX_REDACTION_DEPTH || seen.has(value)) {
    return REDACTED;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactSentryValue(entry, depth + 1, seen));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = isSensitiveSentryKey(key)
      ? REDACTED
      : redactSentryValue(entry, depth + 1, seen);
  }
  return redacted;
}

export function redactSentryEvent(event: unknown): unknown {
  return redactSentryValue(event, 0, new WeakSet<object>());
}
