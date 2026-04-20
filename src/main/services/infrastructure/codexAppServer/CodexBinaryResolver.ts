import { constants as fsConstants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

const CACHE_VERIFY_TTL_MS = 30_000;

let cachedBinaryPath: string | null | undefined;
let cacheVerifiedAt = 0;
let resolveInFlight: Promise<string | null> | null = null;

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

  return [candidate, ...pathext.map((ext) => `${candidate}${ext.toLowerCase()}`)];
}

async function verifyBinary(candidate: string): Promise<string | null> {
  const expandedCandidates = expandWindowsExtensions(candidate);

  if (path.isAbsolute(candidate) || candidate.includes(path.sep)) {
    for (const expandedCandidate of expandedCandidates) {
      if (await fileExists(expandedCandidate)) {
        return expandedCandidate;
      }
    }
    return null;
  }

  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const pathEntry of pathEntries) {
    for (const expandedCandidate of expandedCandidates) {
      const resolvedCandidate = path.join(pathEntry, expandedCandidate);
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
}
