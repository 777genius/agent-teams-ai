import { constants as fsConstants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

import { execCli } from '@main/utils/childProcess';

const CACHE_VERIFY_TTL_MS = 30_000;
const VERSION_CACHE_TTL_MS = 30_000;

let cachedBinaryPath: string | null | undefined;
let cacheVerifiedAt = 0;
let resolveInFlight: Promise<string | null> | null = null;
const versionCache = new Map<string, { version: string | null; observedAt: number }>();

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath, fsConstants.X_OK);
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
  const delimiter = process.platform === 'win32' ? ';' : path.delimiter;
  return (process.env.PATH ?? '').split(delimiter).filter(Boolean);
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
      if (await fileExists(expandedCandidate)) {
        return expandedCandidate;
      }
    }
    return null;
  }

  const pathEntries = getPathEntries();
  for (const pathEntry of pathEntries) {
    for (const expandedCandidate of expandedCandidates) {
      const resolvedCandidate = resolvePathEntryCandidate(pathEntry, expandedCandidate);
      if (await fileExists(resolvedCandidate)) {
        return resolvedCandidate;
      }
    }
  }

  return null;
}

export class CodexBinaryResolver {
  static clearCache(): void {
    cachedBinaryPath = undefined;
    cacheVerifiedAt = 0;
    resolveInFlight = null;
    versionCache.clear();
  }

  static async resolve(): Promise<string | null> {
    if (cachedBinaryPath !== undefined) {
      if (cachedBinaryPath === null) {
        return null;
      }

      if (Date.now() - cacheVerifiedAt <= CACHE_VERIFY_TTL_MS) {
        return cachedBinaryPath;
      }

      const verified = await verifyBinary(cachedBinaryPath);
      if (verified) {
        cacheVerifiedAt = Date.now();
        return verified;
      }

      cachedBinaryPath = undefined;
      cacheVerifiedAt = 0;
    }

    if (!resolveInFlight) {
      resolveInFlight = CodexBinaryResolver.runResolve().finally(() => {
        resolveInFlight = null;
      });
    }

    return resolveInFlight;
  }

  private static async runResolve(): Promise<string | null> {
    const override = process.env.CODEX_CLI_PATH?.trim();
    const candidates = override ? [override, 'codex'] : ['codex'];

    for (const candidate of candidates) {
      const resolved = await verifyBinary(candidate);
      if (resolved) {
        cachedBinaryPath = resolved;
        cacheVerifiedAt = Date.now();
        return resolved;
      }
    }

    cachedBinaryPath = null;
    cacheVerifiedAt = Date.now();
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
