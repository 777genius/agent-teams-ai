import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from '@shared/utils/logger';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

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

/**
 * The opencode config is JSONC wherever it is written, and one of the two paths
 * probed below is literally named `.jsonc`. Strict `JSON.parse` refuses the
 * comments and trailing commas a user's own config carries, and the refusal is
 * silent here: the file is skipped, the provider it configures is never
 * narrowed to, and the runtime the members were actually running on is never
 * asked to release anything. Same parser and same options the rest of the app
 * reads opencode configs with.
 */
function readConfigObject(filePath: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    // A config that is not there is the normal case: at most one of the two
    // spellings exists, and a user with neither has no local provider at all.
    return null;
  }
  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  if (errors.length > 0) {
    // A config this app cannot read is worth saying out loud, because the
    // consequence is a runtime that keeps a model resident with no team left.
    logger.diagnostic(
      `[OpenCode] opencode_loopback_runtime_config_unreadable path=${filePath} errors=${errors.length}`
    );
    return null;
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
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
    const providers = readConfigObject(configPath)?.provider;
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

/**
 * The fallback for a runtime that has no release endpoint at all. Ollama is the
 * one in the wild: it answers 404 there, it lists what it currently holds on
 * `/api/ps`, and it drops a model when a generate call carries `keep_alive: 0`.
 *
 * Only a 404 reaches this. A runtime that answers anything else has the
 * endpoint and failed to serve it, and asking that runtime a second question in
 * a different protocol would be guessing at what it is.
 */
async function evictLoadedModels(
  origin: string,
  fetchImpl: typeof fetch
): Promise<{ evicted: boolean; diagnostics: string[] }> {
  let loaded: { name?: unknown; model?: unknown }[] = [];
  try {
    const response = await fetchImpl(`${origin}/api/ps`, {
      signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        evicted: false,
        diagnostics: [`no release endpoint and no loaded-model list (HTTP ${response.status})`],
      };
    }
    const body = (await response.json()) as { models?: unknown };
    loaded = Array.isArray(body.models) ? (body.models as typeof loaded) : [];
  } catch (error) {
    return {
      evicted: false,
      diagnostics: [
        `loaded-model list failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const diagnostics: string[] = [];
  let evicted = false;
  for (const entry of loaded) {
    const name =
      typeof entry.model === 'string'
        ? entry.model
        : typeof entry.name === 'string'
          ? entry.name
          : null;
    if (!name) continue;
    try {
      const response = await fetchImpl(`${origin}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, keep_alive: 0 }),
        signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
      });
      if (response.ok) {
        evicted = true;
        diagnostics.push(`evicted ${name}`);
      } else {
        diagnostics.push(`evicting ${name} returned HTTP ${response.status}`);
      }
    } catch (error) {
      diagnostics.push(
        `evicting ${name} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { evicted, diagnostics };
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
        continue;
      }
      if (response.status === 404) {
        const eviction = await evictLoadedModels(origin, fetchImpl);
        if (eviction.evicted) {
          result.released.push(providerId);
        }
        result.diagnostics.push(...eviction.diagnostics.map((entry) => `${providerId}: ${entry}`));
        continue;
      }
      result.diagnostics.push(`${providerId}: release returned HTTP ${response.status}`);
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
