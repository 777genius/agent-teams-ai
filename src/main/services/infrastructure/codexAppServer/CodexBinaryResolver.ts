import { constants as fsConstants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

import { resolveVerifiedAppManagedCodexRuntimeBinaryPath } from '@features/codex-runtime-installer/main';
import { execCli } from '@main/utils/childProcess';
import { buildEnrichedEnv } from '@main/utils/cliEnv';
import { buildMergedCliPath } from '@main/utils/cliPathMerge';
import { getCachedShellEnv } from '@main/utils/shellEnv';

const CACHE_VERIFY_TTL_MS = 30_000;
const STALE_POSITIVE_CACHE_TTL_MS = 5 * 60_000;
const VERSION_CACHE_TTL_MS = 30_000;
const BINARY_LAUNCH_VERIFY_TIMEOUT_MS = 3_000;

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

function expandWindowsExtensions(candidate: string): string[] {
  if (process.platform !== 'win32') {
    return [candidate];
  }

  const pathext = process.env.PATHEXT?.split(';').filter(Boolean) ?? [
    '.EXE',
    '.CMD',
    '.BAT',
    '.COM',
  ];
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
  return path.isAbsolute(candidate) || candidate.includes(path.sep);
}

function getPathEntries(): string[] {
  // TODO: Consider sharing runtimePathBinaryResolver here after preserving this resolver's
  // path-like candidate support and Windows PATHEXT normalization exactly.
  const delimiter = process.platform === 'win32' ? ';' : path.delimiter;
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
  return path.join(pathEntry, candidate);
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

export class CodexBinaryResolver {
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
        timeout: 3_000,
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
