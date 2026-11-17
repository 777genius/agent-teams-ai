import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

import { runtimeSourceNativeSelectionSchema } from '@agent-teams/legacy-agent-host/runtime-sources';
import {
  assertCapturedCodexManagedManifest,
  captureAppManagedCodexRuntime,
  captureCodexNativeSelection,
  resolveAppManagedCodexRuntimeBinaryPath,
  resolveVerifiedAppManagedCodexRuntimeBinaryPath,
} from '@features/codex-runtime-installer/main';
import { execCli } from '@main/utils/childProcess';
import { buildEnrichedEnv } from '@main/utils/cliEnv';
import { buildMergedCliPath } from '@main/utils/cliPathMerge';
import { withCliProcessDefaults } from '@main/utils/cliProcessDefaults';
import { isLinuxChildLaunchFailure } from '@main/utils/linuxChildLaunchSelection';
import { createManagedGitEnv } from '@main/utils/managedGit';
import { getCachedShellEnv } from '@main/utils/shellEnv';

import type { RuntimeSourceNativeSelection } from '@agent-teams/legacy-agent-host/runtime-sources';
import type { CapturedCodexManagedManifest } from '@features/codex-runtime-installer/main';

const CACHE_VERIFY_TTL_MS = 30_000;
const STALE_POSITIVE_CACHE_TTL_MS = 5 * 60_000;
const VERSION_CACHE_TTL_MS = 30_000;
const BINARY_LAUNCH_VERIFY_TIMEOUT_MS = 15_000;

let cachedBinaryPath: string | null | undefined;
let cacheVerifiedAt = 0;
let cacheLaunchVerifiedAt = 0;
let resolveInFlight: Promise<string | null> | null = null;
let cachedMissHadShellEnv = false;
let cachedPositiveIsStale = false;
const versionCache = new Map<string, { version: string | null; observedAt: number }>();

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function binaryCanLaunch(candidate: string): Promise<boolean> {
  try {
    await execCli(candidate, ['--version'], {
      env: buildEnrichedEnv(candidate),
      timeout: BINARY_LAUNCH_VERIFY_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function expandWindowsExtensions(candidate: string, pathExt = process.env.PATHEXT): string[] {
  if (process.platform !== 'win32') {
    return [candidate];
  }

  const pathext = pathExt?.split(';').filter(Boolean) ?? ['.EXE', '.CMD', '.BAT', '.COM'];
  const hasKnownExtension = pathext.some((ext) =>
    candidate.toLowerCase().endsWith(ext.toLowerCase())
  );

  if (hasKnownExtension) {
    return [candidate];
  }

  return [...pathext.map((ext) => `${candidate}${ext.toLowerCase()}`), candidate];
}

function isPathLikeCandidate(candidate: string): boolean {
  if (process.platform === 'win32') {
    return path.win32.isAbsolute(candidate) || candidate.includes('\\') || candidate.includes('/');
  }
  // path.posix rather than the host's path: identical on a POSIX host, and it
  // keeps the non-Windows branch meaningful when the platform is simulated.
  return path.posix.isAbsolute(candidate) || candidate.includes(path.posix.sep);
}

function getPathEntries(): string[] {
  // TODO: Consider sharing runtimePathBinaryResolver here after preserving this resolver's
  // path-like candidate support and Windows PATHEXT normalization exactly.
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const shellEnv = getCachedShellEnv() ?? {};
  const seen = new Set<string>();
  return [shellEnv.PATH, buildMergedCliPath(null), process.env.PATH]
    .flatMap((pathValue) => (pathValue ?? '').split(delimiter))
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (!entry || seen.has(entry)) {
        return false;
      }
      seen.add(entry);
      return true;
    });
}

function resolvePathEntryCandidate(pathEntry: string, candidate: string): string {
  if (process.platform === 'win32') {
    return path.win32.join(pathEntry, candidate);
  }
  return path.posix.join(pathEntry, candidate);
}

async function verifyBinary(candidate: string): Promise<string | null> {
  const expandedCandidates = expandWindowsExtensions(candidate);

  if (isPathLikeCandidate(candidate)) {
    for (const expandedCandidate of expandedCandidates) {
      if ((await fileExists(expandedCandidate)) && (await binaryCanLaunch(expandedCandidate))) {
        return expandedCandidate;
      }
    }
    return null;
  }

  const pathEntries = getPathEntries();
  for (const pathEntry of pathEntries) {
    for (const expandedCandidate of expandedCandidates) {
      const resolvedCandidate = resolvePathEntryCandidate(pathEntry, expandedCandidate);
      if ((await fileExists(resolvedCandidate)) && (await binaryCanLaunch(resolvedCandidate))) {
        return resolvedCandidate;
      }
    }
  }

  return null;
}

async function canReuseStalePositiveBinary(
  candidate: string | null,
  launchVerifiedAt: number
): Promise<boolean> {
  if (
    !candidate ||
    launchVerifiedAt <= 0 ||
    Date.now() - launchVerifiedAt > STALE_POSITIVE_CACHE_TTL_MS
  ) {
    return false;
  }

  return fileExists(candidate);
}

export interface CapturedCodexResolution {
  readonly selection: RuntimeSourceNativeSelection;
  assertCurrent(): Promise<void>;
}

export interface CapturedCodexResolver {
  readonly fingerprint: string;
  assertAuthority(): void;
  assertCurrent(): void;
  acceptAcquired(manifest: CapturedCodexManagedManifest): void;
  resolve(): Promise<CapturedCodexResolution | null>;
}

function environmentWitness(env: NodeJS.ProcessEnv | null): string {
  return JSON.stringify(
    env === null
      ? null
      : Object.keys(env)
          .sort()
          .map((key) => [key, env[key]])
  );
}

function confirmedMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(String(error.code))
  );
}

/** Only original execCli outcomes with no unknown handoff/cleanup may advance the candidate list. */
function confirmedLaunchFailure(
  error: unknown,
  invocation: Awaited<ReturnType<typeof captureCodexNativeSelection>>
): boolean {
  if (
    !(error instanceof Error) ||
    isLinuxChildLaunchFailure(error) ||
    error.name === 'AbortError' ||
    Reflect.get(error, 'killed') === true ||
    Reflect.get(error, 'signal') != null ||
    Reflect.get(error, 'processOutcomeUnknown') === true ||
    Object.hasOwn(error, 'processTerminationError')
  )
    return false;
  const code: unknown = Reflect.get(error, 'code');
  // An interpreter exit alone does not confirm its native child's cleanup.
  if (typeof code === 'number' && Number.isInteger(code) && code > 0) return !invocation.indirect;
  const failedPath: unknown = Reflect.get(error, 'path');
  return (
    typeof code === 'string' &&
    ['ENOENT', 'ENOTDIR', 'EACCES', 'ENOEXEC', 'EPERM'].includes(code) &&
    (failedPath === invocation.invocationPath ||
      failedPath === invocation.processPath ||
      (!invocation.indirect && failedPath === invocation.executable.path)) &&
    Reflect.get(error, 'syscall') === `spawn ${String(failedPath)}`
  );
}

export class CodexBinaryResolver {
  /** Private captured installer entry. No legacy resolver/cache is read or changed. */
  static captureSelection(isCurrent: () => boolean): CapturedCodexResolver {
    const platform = process.platform,
      arch = process.arch,
      cwd = process.cwd(),
      shell = getCachedShellEnv();
    const processWitness = environmentWitness(process.env),
      shellWitness = environmentWitness(shell);
    const environment = Object.freeze({
      ...withCliProcessDefaults({ env: buildEnrichedEnv(null) }).env,
    });
    const environmentKey = environmentWitness(environment);
    const mergedPath = buildMergedCliPath(null);
    const pathPrefix = createManagedGitEnv({ PATH: '' }).PATH ?? '';
    const separator = platform === 'win32' ? ';' : ':';
    const probe = Object.freeze({
      cwd,
      environment,
      pathPrefix: Object.freeze(pathPrefix.split(separator).filter(Boolean)),
      pathBase: Object.freeze(mergedPath.split(separator).filter(Boolean)),
    });
    const processOverride = process.env.CODEX_CLI_PATH?.trim();
    const shellOverride = shell?.CODEX_CLI_PATH?.trim();
    const pathExt = process.env.PATHEXT;
    const pathEntries = Object.freeze(getPathEntries());
    let managed = captureAppManagedCodexRuntime();
    let acquired = false;
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          platform,
          arch,
          cwd,
          processWitness,
          shellWitness,
          environmentKey,
          mergedPath,
          pathPrefix,
          processOverride,
          shellOverride,
          pathExt,
          pathEntries,
          managed: managed.fingerprint,
        })
      )
      .digest('hex');
    const assertAuthority = () => {
      if (
        !isCurrent() ||
        process.platform !== platform ||
        process.arch !== arch ||
        process.cwd() !== cwd ||
        getCachedShellEnv() !== shell ||
        environmentWitness(process.env) !== processWitness ||
        environmentWitness(shell) !== shellWitness ||
        buildMergedCliPath(null) !== mergedPath ||
        (createManagedGitEnv({ PATH: '' }).PATH ?? '') !== pathPrefix ||
        environmentWitness(withCliProcessDefaults({ env: buildEnrichedEnv(null) }).env) !==
          environmentKey
      )
        throw new Error('The original Codex installation context changed.');
    };
    const assertCurrent = () => {
      assertAuthority();
      managed.assertCurrent();
    };
    assertCurrent();
    let resolution: Promise<CapturedCodexResolution | null> | undefined;
    return Object.freeze({
      fingerprint,
      assertAuthority,
      assertCurrent,
      acceptAcquired(manifest: CapturedCodexManagedManifest) {
        assertAuthority();
        if (acquired || resolution) throw new Error('Codex acquisition was already reconciled.');
        assertCapturedCodexManagedManifest(manifest);
        managed = manifest;
        acquired = true;
      },
      resolve() {
        if (resolution) return resolution;
        const deadline = performance.now() + BINARY_LAUNCH_VERIFY_TIMEOUT_MS;
        let resolving = true;
        const check = () => {
          assertCurrent();
          if (resolving && performance.now() >= deadline)
            throw new Error('The original Codex resolution deadline expired.');
        };
        const checked = async <T>(work: () => Promise<T>): Promise<T> => {
          check();
          try {
            return await work();
          } finally {
            check();
          }
        };
        resolution = (async () => {
          const candidates: {
            candidate: string;
            sourceKind: 'override' | 'app-managed' | 'path';
          }[] = [];
          for (const override of new Set([processOverride, shellOverride]))
            if (override) candidates.push({ candidate: override, sourceKind: 'override' });
          if (managed.binaryPath)
            candidates.push({ candidate: managed.binaryPath, sourceKind: 'app-managed' });
          candidates.push({ candidate: 'codex', sourceKind: 'path' });
          for (const { candidate, sourceKind } of candidates) {
            check();
            const expanded = expandWindowsExtensions(candidate, pathExt);
            const paths = isPathLikeCandidate(candidate)
              ? expanded
              : pathEntries.flatMap((entry) =>
                  expanded.map((value) => resolvePathEntryCandidate(entry, value))
                );
            for (const selected of paths) {
              try {
                await checked(() => fsp.access(selected, fsConstants.X_OK));
              } catch (error) {
                if (confirmedMissing(error)) continue;
                throw error;
              }
              let invocation: Awaited<ReturnType<typeof captureCodexNativeSelection>>;
              try {
                invocation = await checked(() =>
                  captureCodexNativeSelection(selected, check, probe)
                );
              } catch (error) {
                // An unreadable image or missing wrapper dependency is not a failed original launch.
                if (
                  error instanceof Error &&
                  Reflect.get(error, 'path') === selected &&
                  ['ENOENT', 'ENOTDIR'].includes(String(Reflect.get(error, 'code')))
                )
                  continue;
                throw error;
              }
              let stdout: string;
              try {
                ({ stdout } = await checked(() =>
                  execCli(invocation.invocationPath, ['--version'], {
                    cwd,
                    env: invocation.environment,
                    timeout: Math.max(1, Math.floor(deadline - performance.now())),
                    windowsHide: true,
                  })
                ));
              } catch (error) {
                if (confirmedLaunchFailure(error, invocation)) continue;
                throw error;
              }
              await checked(() => invocation.assertCurrent());
              const version =
                /^(?:codex-cli\s+)?((?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8}))$/.exec(
                  stdout.trim()
                )?.[1];
              if (!version) throw new Error('The original Codex version could not be confirmed.');
              const selection = runtimeSourceNativeSelectionSchema.parse({
                sourceKind,
                nativeCli: { executable: invocation.executable, version },
              });
              return Object.freeze({
                selection,
                assertCurrent: () => checked(() => invocation.assertCurrent()),
              });
            }
          }
          check();
          return null;
        })().finally(() => {
          resolving = false;
        });
        return resolution;
      },
    });
  }

  static async verifyCandidate(candidate: string): Promise<string | null> {
    const normalizedCandidate = candidate.trim();
    return normalizedCandidate ? verifyBinary(normalizedCandidate) : null;
  }

  static clearCache(): void {
    cachedBinaryPath = undefined;
    cacheVerifiedAt = 0;
    cacheLaunchVerifiedAt = 0;
    resolveInFlight = null;
    cachedMissHadShellEnv = false;
    cachedPositiveIsStale = false;
    versionCache.clear();
  }

  static async resolve(): Promise<string | null> {
    let stalePositiveBinaryPath: string | null = null;
    let stalePositiveLaunchVerifiedAt = 0;

    if (cachedBinaryPath !== undefined) {
      if (cachedBinaryPath === null) {
        if (!cachedMissHadShellEnv && getCachedShellEnv() !== null) {
          cachedBinaryPath = undefined;
          cacheVerifiedAt = 0;
          cacheLaunchVerifiedAt = 0;
          cachedMissHadShellEnv = false;
          cachedPositiveIsStale = false;
        } else {
          const verifiedAppManagedBinaryPath =
            await resolveVerifiedAppManagedCodexRuntimeBinaryPath();
          if (verifiedAppManagedBinaryPath) {
            const now = Date.now();
            cachedBinaryPath = verifiedAppManagedBinaryPath;
            cacheVerifiedAt = now;
            cacheLaunchVerifiedAt = now;
            cachedMissHadShellEnv = false;
            cachedPositiveIsStale = false;
            return verifiedAppManagedBinaryPath;
          }
          if (Date.now() - cacheVerifiedAt <= CACHE_VERIFY_TTL_MS) {
            return null;
          }
          cachedBinaryPath = undefined;
          cacheVerifiedAt = 0;
          cacheLaunchVerifiedAt = 0;
          cachedMissHadShellEnv = false;
          cachedPositiveIsStale = false;
        }
      } else {
        const now = Date.now();
        const stalePositiveIsStillAllowed =
          !cachedPositiveIsStale || now - cacheLaunchVerifiedAt <= STALE_POSITIVE_CACHE_TTL_MS;
        if (now - cacheVerifiedAt <= CACHE_VERIFY_TTL_MS && stalePositiveIsStillAllowed) {
          return cachedBinaryPath;
        }

        const cachedPositiveBinaryPath = cachedBinaryPath;
        const cachedPositiveLaunchVerifiedAt = cacheLaunchVerifiedAt;
        // Keep verified overrides first, but let stale overrides fall through to
        // a newly installed app-managed runtime before reusing the old PATH binary.
        const processOverride = process.env.CODEX_CLI_PATH?.trim();
        const shellOverride = getCachedShellEnv()?.CODEX_CLI_PATH?.trim();
        for (const override of new Set([processOverride, shellOverride])) {
          if (!override) {
            continue;
          }
          const verifiedOverride = await verifyBinary(override);
          if (verifiedOverride) {
            cachedBinaryPath = verifiedOverride;
            cacheVerifiedAt = Date.now();
            cacheLaunchVerifiedAt = cacheVerifiedAt;
            cachedMissHadShellEnv = false;
            cachedPositiveIsStale = false;
            return verifiedOverride;
          }
        }
        const appManagedBinaryPath = resolveAppManagedCodexRuntimeBinaryPath();
        if (appManagedBinaryPath && appManagedBinaryPath !== cachedPositiveBinaryPath) {
          const verifiedAppManagedBinaryPath = await verifyBinary(appManagedBinaryPath);
          if (verifiedAppManagedBinaryPath) {
            cachedBinaryPath = verifiedAppManagedBinaryPath;
            cacheVerifiedAt = Date.now();
            cacheLaunchVerifiedAt = cacheVerifiedAt;
            cachedMissHadShellEnv = false;
            cachedPositiveIsStale = false;
            return verifiedAppManagedBinaryPath;
          }
        }
        const verified = await verifyBinary(cachedPositiveBinaryPath);
        if (verified) {
          const verifiedAt = Date.now();
          cacheVerifiedAt = verifiedAt;
          cacheLaunchVerifiedAt = verifiedAt;
          cachedMissHadShellEnv = false;
          cachedPositiveIsStale = false;
          return verified;
        }

        stalePositiveBinaryPath = cachedPositiveBinaryPath;
        stalePositiveLaunchVerifiedAt = cachedPositiveLaunchVerifiedAt;
        cachedBinaryPath = undefined;
        cacheVerifiedAt = 0;
        cacheLaunchVerifiedAt = 0;
        cachedPositiveIsStale = false;
      }
    }

    if (!resolveInFlight) {
      resolveInFlight = CodexBinaryResolver.runResolve().finally(() => {
        resolveInFlight = null;
      });
    }

    const resolved = await resolveInFlight;
    if (
      !resolved &&
      (await canReuseStalePositiveBinary(stalePositiveBinaryPath, stalePositiveLaunchVerifiedAt))
    ) {
      cachedBinaryPath = stalePositiveBinaryPath;
      cacheVerifiedAt = Date.now();
      cacheLaunchVerifiedAt = stalePositiveLaunchVerifiedAt;
      cachedMissHadShellEnv = false;
      cachedPositiveIsStale = true;
      return stalePositiveBinaryPath;
    }

    return resolved;
  }

  private static async runResolve(): Promise<string | null> {
    const override = process.env.CODEX_CLI_PATH?.trim();
    const shellOverride = getCachedShellEnv()?.CODEX_CLI_PATH?.trim();
    const appManagedBinaryPath = await resolveVerifiedAppManagedCodexRuntimeBinaryPath();
    const candidates = [
      ...(override ? [override] : []),
      ...(shellOverride && shellOverride !== override ? [shellOverride] : []),
      ...(appManagedBinaryPath ? [appManagedBinaryPath] : []),
      'codex',
    ];

    for (const candidate of candidates) {
      const resolved = await verifyBinary(candidate);
      if (resolved) {
        const now = Date.now();
        cachedBinaryPath = resolved;
        cacheVerifiedAt = now;
        cacheLaunchVerifiedAt = now;
        cachedMissHadShellEnv = false;
        cachedPositiveIsStale = false;
        return resolved;
      }
    }

    cachedBinaryPath = null;
    cacheVerifiedAt = Date.now();
    cacheLaunchVerifiedAt = 0;
    cachedMissHadShellEnv = getCachedShellEnv() !== null;
    cachedPositiveIsStale = false;
    return null;
  }

  static async resolveVersion(binaryPath: string | null | undefined): Promise<string | null> {
    const normalizedPath = binaryPath?.trim();
    if (!normalizedPath) {
      return null;
    }

    const cached = versionCache.get(normalizedPath);
    if (cached && Date.now() - cached.observedAt <= VERSION_CACHE_TTL_MS) {
      return cached.version;
    }

    try {
      const result = await execCli(normalizedPath, ['--version'], {
        env: buildEnrichedEnv(normalizedPath),
        timeout: BINARY_LAUNCH_VERIFY_TIMEOUT_MS,
      });
      const version = result.stdout.trim().split(/\s+/).filter(Boolean).at(-1) ?? null;
      versionCache.set(normalizedPath, {
        version,
        observedAt: Date.now(),
      });
      return version;
    } catch {
      versionCache.set(normalizedPath, {
        version: null,
        observedAt: Date.now(),
      });
      return null;
    }
  }
}
