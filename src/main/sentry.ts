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
import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { getSharedTelemetryBuildProperties } from '@shared/utils/buildMetadata';
import {
  filterSafeSentryIntegrations,
  isValidDsn,
  redactSentryEvent,
  SENTRY_ENVIRONMENT,
  SENTRY_RELEASE,
  TRACES_SAMPLE_RATE,
} from '@shared/utils/sentryConfig';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Telemetry gate
// ---------------------------------------------------------------------------

const CONFIG_FILENAME = 'agent-teams-config.json';
const LEGACY_CONFIG_FILENAMES = [
  'claude-devtools-config.json',
  'claude-code-context-config.json',
] as const;

export interface SentryTelemetryContext {
  userId: string;
  tags: Record<string, string>;
}

function readTelemetryFlagFromConfig(configPath: string): boolean | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const general = (parsed as { general?: unknown }).general;
    if (typeof general !== 'object' || general === null || Array.isArray(general)) {
      return null;
    }

    const telemetryEnabled = (general as { telemetryEnabled?: unknown }).telemetryEnabled;
    return typeof telemetryEnabled === 'boolean' ? telemetryEnabled : null;
  } catch {
    return null;
  }
}

export function readPersistedTelemetryEnabled(basePath = getClaudeBasePath()): boolean {
  const currentPath = path.join(basePath, CONFIG_FILENAME);
  if (fs.existsSync(currentPath)) {
    return readTelemetryFlagFromConfig(currentPath) ?? true;
  }

  const legacyPaths = LEGACY_CONFIG_FILENAMES.map((filename) => path.join(basePath, filename));
  const readableLegacyPath =
    legacyPaths.find((candidatePath) => readTelemetryFlagFromConfig(candidatePath) !== null) ??
    legacyPaths.find((candidatePath) => fs.existsSync(candidatePath));

  return readableLegacyPath ? (readTelemetryFlagFromConfig(readableLegacyPath) ?? true) : true;
}

// Module-level flag that `beforeSend` checks. Read persisted config before init
// so telemetry-disabled users do not start Sentry sessions on app startup.
let telemetryAllowed = readPersistedTelemetryEnabled();
let telemetryIdentitySyncToken = 0;

export function getSafeSentryTelemetryTags(
  identitySource: AgentTeamsIdentitySource
): Record<string, string> {
  return {
    ...getSharedTelemetryBuildProperties(),
    platform: process.platform,
    arch: process.arch,
    identity_source: identitySource,
  };
}

/**
 * Call once ConfigManager is initialised to sync the opt-in flag.
 * Also call whenever the config changes (e.g. user toggles telemetry in Settings).
 */
export function syncTelemetryFlag(enabled: boolean): void {
  telemetryAllowed = enabled;
  if (!enabled) {
    telemetryIdentitySyncToken++;
    shutdownSentry();
    return;
  }

  initializeSentryIfAllowed();
  void syncTelemetryIdentity();
}

export function filterSentryEventForTelemetry(event: unknown): unknown {
  return telemetryAllowed ? redactSentryEvent(event) : null;
}

// ---------------------------------------------------------------------------
// Lazy Sentry import - safe in non-Electron environments
// ---------------------------------------------------------------------------

interface SentryMainApi {
  init?: (options: SentryInitOptions) => void;
  setUser?: (user: { id: string } | null) => void;
  setTags?: (tags: Record<string, string>) => void;
  close?: (timeout?: number) => PromiseLike<boolean> | boolean;
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
  integrations: <TIntegration extends { name?: string }>(
    integrations: TIntegration[]
  ) => TIntegration[];
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

function shutdownSentry(): void {
  const sentry = Sentry;
  if (initialized && sentry) {
    sentry.setUser?.(null);
    try {
      void Promise.resolve(sentry.close?.(2000)).catch(() => undefined);
    } catch {
      // Best effort only. The telemetry gate still blocks later events.
    }
  }

  initialized = false;
  Sentry = null;
}

export async function getCurrentSentryTelemetryContext(): Promise<SentryTelemetryContext | null> {
  if (!telemetryAllowed) {
    return null;
  }

  try {
    const identity = await ensureAgentTeamsClientIdentity();
    if (!telemetryAllowed) {
      return null;
    }

    return {
      userId: getSentryAnonymousUserId(identity.clientId),
      tags: getSafeSentryTelemetryTags(identity.source),
    };
  } catch {
    return null;
  }
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
    const context = await getCurrentSentryTelemetryContext();
    if (syncToken !== telemetryIdentitySyncToken || !telemetryAllowed) {
      return;
    }

    if (!context) {
      clearSentryUser();
      return;
    }

    Sentry.setUser?.({ id: context.userId });
    Sentry.setTags?.(context.tags);
  } catch {
    if (syncToken === telemetryIdentitySyncToken) {
      clearSentryUser();
    }
  }
}

function initializeSentryIfAllowed(): void {
  if (initialized || !telemetryAllowed) {
    return;
  }

  const dsn = process.env.SENTRY_DSN;
  if (!isValidDsn(dsn)) {
    return;
  }

  try {
    // Dynamic import would be cleaner but top-level await is not available
    // in all contexts. require() is synchronous and works in both Electron
    // and Node.js - it simply throws in standalone mode where the electron
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
      integrations: filterSafeSentryIntegrations,
    });
    initialized = true;
    void syncTelemetryIdentity();
  } catch {
    Sentry = null;
    initialized = false;
    // @sentry/electron/main requires Electron runtime - not available in
    // standalone (pure Node.js) mode. All exported helpers are no-ops when
    // initialized is false, so this is safe to swallow.
  }
}

initializeSentryIfAllowed();

// ---------------------------------------------------------------------------
// Public helpers (no-op when Sentry is not configured)
// ---------------------------------------------------------------------------

/** Record a breadcrumb visible in subsequent error events. */
export function addMainBreadcrumb(
  category: string,
  message: string,
  _data?: Record<string, unknown>
): void {
  if (!initialized) return;
  Sentry?.addBreadcrumb?.({ category, message, level: 'info' });
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
