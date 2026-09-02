import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from '@shared/utils/logger';

const logger = createLogger('OpenCodeLoopbackRuntimeRelease');

/**
 * A loopback OpenAI-compatible runtime keeps the model it last served resident
 * so a lane wake-up never pays a cold reload. That reservation is worth holding
 * for as long as a team is running and worth nothing the moment the last one
 * stops - but the runtime cannot tell the two apart on its own, because all it
 * ever sees is requests arriving or not arriving.
 *
 * So the app says it out loud: once the last team is down, every loopback
 * provider from the user's opencode config that the stopped members were
 * running on is asked to release what it reserved for them.
 *
 * Two rules keep this from turning into an outbound request to somebody else's
 * server, and they are the whole reason the module is shaped this way. Only a
 * base URL on the loopback interface is ever contacted, and only a provider the
 * stopped members actually used. Everything after that is best effort and
 * bounded: a runtime that does not answer is a diagnostic, never a failed stop.
 *
 * Opt out with AGENT_TEAMS_RUNTIME_RELEASE_DISABLED=1.
 */

/**
 * Set to `1` by a deployment whose loopback runtime is shared with something
 * outside this app, where releasing it after a stop would be a surprise.
 */
export const RUNTIME_RELEASE_DISABLED_ENV = 'AGENT_TEAMS_RUNTIME_RELEASE_DISABLED';

/**
 * The loopback interface, in every spelling a base URL can carry it. Nothing
 * else is a runtime this app is entitled to stand down: a hostname that
 * resolves elsewhere belongs to somebody else, however local it looks.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const RELEASE_TIMEOUT_MS = 5_000;

export interface LoopbackRuntimeReleaseOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /**
   * Only the providers these models ran on are released (`<provider>/<model>`).
   * Omitted means every configured loopback provider, which is the app-shutdown
   * case: no team is left to attribute a reservation to.
   */
  memberModels?: readonly (string | undefined | null)[];
  fetchImpl?: typeof fetch;
  configPaths?: readonly string[];
}

export interface LoopbackRuntimeReleaseResult {
  /** Release endpoints called, in call order; empty means nothing was contacted. */
  attempted: string[];
  released: string[];
  diagnostics: string[];
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Local provider id -> origin, for the loopback providers only. A provider
 * whose base URL points anywhere else is dropped here, once, so that no later
 * step in this module can reach it by accident.
 */
export function resolveLocalProviderOrigins(
  options: LoopbackRuntimeReleaseOptions = {}
): Map<string, string> {
  const homeDir = options.homeDir ?? os.homedir();
  const configPaths = options.configPaths ?? [
    path.join(homeDir, '.config', 'opencode', 'opencode.json'),
    path.join(homeDir, '.config', 'opencode', 'opencode.jsonc'),
  ];
  const origins = new Map<string, string>();
  for (const configPath of configPaths) {
    const providers = readJsonObject(configPath)?.provider;
    if (!providers || typeof providers !== 'object') continue;
    for (const [providerId, provider] of Object.entries(providers as Record<string, unknown>)) {
      const providerOptions = (provider as { options?: { baseURL?: unknown } } | null)?.options;
      const baseURL =
        typeof providerOptions?.baseURL === 'string' ? providerOptions.baseURL.trim() : '';
      if (!baseURL) continue;
      try {
        const url = new URL(baseURL);
        if (!LOOPBACK_HOSTS.has(url.hostname)) continue;
        origins.set(providerId, url.origin);
      } catch {
        // Not a URL, so not an origin this app can address.
      }
    }
  }
  return origins;
}

/**
 * Narrows the configured loopback providers to the ones the stopped team was
 * running on. A user can have several configured and be using one; the others
 * are serving somebody else and must not hear from this stop at all.
 */
export function selectProvidersUsedByModels(
  origins: Map<string, string>,
  memberModels: readonly (string | undefined | null)[] | undefined
): Map<string, string> {
  if (!memberModels) return origins;
  const used = new Set<string>();
  for (const model of memberModels) {
    const normalized = typeof model === 'string' ? model.trim() : '';
    const slash = normalized.indexOf('/');
    if (slash > 0) used.add(normalized.slice(0, slash));
  }
  return new Map([...origins].filter(([providerId]) => used.has(providerId)));
}

export async function releaseLoopbackRuntimeModels(
  options: LoopbackRuntimeReleaseOptions = {}
): Promise<LoopbackRuntimeReleaseResult> {
  const env = options.env ?? process.env;
  const result: LoopbackRuntimeReleaseResult = { attempted: [], released: [], diagnostics: [] };
  if (env[RUNTIME_RELEASE_DISABLED_ENV]?.trim() === '1') {
    return result;
  }
  const origins = selectProvidersUsedByModels(
    resolveLocalProviderOrigins(options),
    options.memberModels
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  for (const [providerId, origin] of origins) {
    const url = `${origin}/api/models/unload`;
    result.attempted.push(url);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
      });
      if (response.ok) {
        result.released.push(providerId);
      } else {
        result.diagnostics.push(`${providerId}: release returned HTTP ${response.status}`);
      }
    } catch (error) {
      // A runtime that is already gone, refusing connections or too slow to
      // answer has, in every one of those cases, nothing left to release.
      result.diagnostics.push(
        `${providerId}: release failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  reportReleaseOutcome(result);
  return result;
}

/**
 * Both production callers hand this to a `Promise<void>` port, so the result is
 * theirs to ignore and the evidence has to be durable here. `diagnostic` rather
 * than `warn`: a loopback runtime that did not answer a courtesy call is not a
 * problem anyone should be shown, and it is exactly what someone reconstructing
 * a stop afterwards needs to read.
 */
function reportReleaseOutcome(result: LoopbackRuntimeReleaseResult): void {
  if (result.attempted.length === 0) return;
  logger.diagnostic(
    `[OpenCode] opencode_loopback_runtime_released count=${result.released.length} ` +
      `providers=${result.released.join('/') || 'none'} attempted=${result.attempted.length}`
  );
  for (const diagnostic of result.diagnostics) {
    logger.diagnostic(`[OpenCode] opencode_loopback_runtime_release_failed detail=${diagnostic}`);
  }
}

/**
 * The app-exit half. It takes no member filter because at exit there is no team
 * left to take one from: what the app knows at that point is only that nothing
 * it started is still running, so every loopback runtime in the config is asked
 * to stand down. The loopback rule is the one that still holds, and it is the
 * one that matters.
 */
export function releaseLoopbackRuntimesOnAppShutdown(): Promise<void> {
  return releaseLoopbackRuntimeModels().then(() => undefined);
}
