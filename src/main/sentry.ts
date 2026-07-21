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

import type { SentryTelemetryStatus } from '@shared/types/api';

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

  initializeMainSentry();
  void syncTelemetryIdentity();
}

export function filterSentryEventForTelemetry(event: unknown): unknown {
  return telemetryAllowed ? redactSentryEvent(event) : null;
}

// ---------------------------------------------------------------------------
// Lazy Sentry import - safe in non-Electron environments
// ---------------------------------------------------------------------------

interface SentryMainApi {
  IPCMode?: { Classic?: number };
  init?: (options: SentryInitOptions) => void;
  captureException?: (
    error: unknown,
    context?: { tags?: Record<string, string> }
  ) => string | undefined;
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
  ipcMode: number;
}

type SentryMainLoader = () => unknown;

const defaultSentryMainLoader: SentryMainLoader = () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy optional Electron runtime dependency.
  return require('@sentry/electron/main') as SentryMainApi;
};

let Sentry: SentryMainApi | null = null;
let initialized = false;
let initFailureReason: SentryTelemetryStatus['reason'] = null;
let loadSentryMainApi = defaultSentryMainLoader;

const SENTRY_IPC_NAMESPACE = 'sentry-ipc';
const SENTRY_IPC_CHANNELS = [
  'start',
  'scope',
  'envelope',
  'status',
  'structured-log',
  'metric',
] as const;

export function setMainSentryApiForTesting(sentryApi: SentryMainApi): void {
  if (process.env.NODE_ENV !== 'test') return;
  Sentry = sentryApi;
  initialized = true;
  initFailureReason = null;
}

export function setMainSentryLoaderForTesting(loader: SentryMainLoader | null): void {
  if (process.env.NODE_ENV !== 'test') return;
  loadSentryMainApi = loader ?? defaultSentryMainLoader;
}

function clearSentryUser(): void {
  if (!initialized || !Sentry) return;
  Sentry.setUser?.(null);
}

function removeMainSentryIpcListeners(): void {
  try {
    // Keep Electron optional so standalone mode can import this module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional Electron runtime dependency.
    const electron = require('electron') as {
      ipcMain?: { removeAllListeners: (channel: string) => unknown };
    };
    for (const channel of SENTRY_IPC_CHANNELS) {
      electron.ipcMain?.removeAllListeners(`${SENTRY_IPC_NAMESPACE}.${channel}`);
    }
  } catch {
    // Electron is unavailable in standalone mode.
  }
}

function closeSentryClient(sentry: SentryMainApi): void {
  try {
    void Promise.resolve(sentry.close?.(2000)).catch(() => undefined);
  } catch {
    // Best effort only. The telemetry gate still blocks later events.
  }
}

function shutdownSentry(): void {
  const sentry = Sentry;
  removeMainSentryIpcListeners();
  if (initialized && sentry) {
    sentry.setUser?.(null);
    closeSentryClient(sentry);
  }

  initialized = false;
  Sentry = null;
}

export function getMainSentryStatus(): SentryTelemetryStatus {
  const dsnConfigured = isValidDsn(process.env.SENTRY_DSN);
  let state: SentryTelemetryStatus['state'];
  let reason: SentryTelemetryStatus['reason'];

  if (!telemetryAllowed) {
    state = 'disabled';
    reason = 'telemetry-disabled';
  } else if (!dsnConfigured) {
    state = 'unconfigured';
    reason = 'invalid-dsn';
  } else if (initialized && Sentry) {
    state = 'active';
    reason = null;
  } else {
    state = 'failed';
    reason = initFailureReason ?? 'sdk-init-failed';
  }

  return {
    state,
    reason,
    environment: SENTRY_ENVIRONMENT,
    release: SENTRY_RELEASE ?? null,
  };
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

export function initializeMainSentry(): void {
  if (initialized || !telemetryAllowed) {
    return;
  }

  const dsn = process.env.SENTRY_DSN;
  if (!isValidDsn(dsn)) {
    initFailureReason = null;
    return;
  }

  let sentryApi: SentryMainApi;
  try {
    sentryApi = loadSentryMainApi() as SentryMainApi;
  } catch {
    Sentry = null;
    initialized = false;
    initFailureReason = 'sdk-load-failed';
    return;
  }

  Sentry = sentryApi;
  try {
    const classicIpcMode = sentryApi.IPCMode?.Classic;
    if (typeof sentryApi.init !== 'function' || typeof classicIpcMode !== 'number') {
      throw new Error('Sentry Electron classic IPC is unavailable');
    }

    sentryApi.init({
      dsn,
      release: SENTRY_RELEASE,
      environment: SENTRY_ENVIRONMENT,
      tracesSampleRate: TRACES_SAMPLE_RATE,
      sendDefaultPii: false,

      beforeSend: filterSentryEventForTelemetry,
      beforeSendTransaction: filterSentryEventForTelemetry,
      integrations: filterSafeSentryIntegrations,
      // The app provides an explicit classic preload bridge. Protocol mode
      // cannot be registered after Electron ready when telemetry is enabled later.
      ipcMode: classicIpcMode,
    });
    initialized = true;
    initFailureReason = null;
    void syncTelemetryIdentity();
  } catch {
    removeMainSentryIpcListeners();
    closeSentryClient(sentryApi);
    Sentry = null;
    initialized = false;
    initFailureReason = 'sdk-init-failed';
  }
}

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

/** Capture a handled main-process exception with a bounded, low-cardinality operation tag. */
export function captureMainException(error: unknown, operation: string): string | undefined {
  if (!initialized || !telemetryAllowed || !Sentry?.captureException) {
    return undefined;
  }

  const safeOperation = /^[a-z0-9_.:-]{1,64}$/.test(operation) ? operation : 'main_unknown';
  const exception = error instanceof Error ? error : new Error('Non-Error exception');
  return Sentry.captureException(exception, {
    tags: { 'error.operation': safeOperation },
  });
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
