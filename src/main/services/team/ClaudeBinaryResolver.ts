import { buildMergedCliPath } from '@main/utils/cliPathMerge';
import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { getShellPreferredHome, resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import * as fs from 'fs';
import * as path from 'path';

import { getDoctorInvokedCandidates } from './ClaudeDoctorProbe';
import { getConfiguredCliFlavor } from './cliFlavor';

async function isExecutable(filePath: string): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  try {
    await fs.promises.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function getWindowsExecutableExtensions(): string[] {
  const raw = process.env.PATHEXT;
  if (!raw) {
    return ['.exe', '.cmd', '.bat', '.com'];
  }

  const exts = raw
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0)
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`))
    .map((ext) => ext.toLowerCase());

  return Array.from(new Set(exts));
}

function expandWindowsBinaryNames(binaryName: string): string[] {
  const trimmed = binaryName.trim();
  if (!trimmed) {
    return [];
  }

  const ext = path.extname(trimmed);
  if (ext) {
    return [trimmed];
  }

  const exts = getWindowsExecutableExtensions();
  const withExt = exts.map((e) => `${trimmed}${e}`);
  return [...withExt, trimmed];
}

async function collectNvmCandidates(): Promise<string[]> {
  if (process.platform === 'win32') {
    return collectNvmWindowsCandidates();
  }

  const nvmNodeRoot = path.join(getShellPreferredHome(), '.nvm', 'versions', 'node');
  let versions: string[];
  try {
    versions = await fs.promises.readdir(nvmNodeRoot);
  } catch {
    return [];
  }

  return versions
    .map((version) => path.join(nvmNodeRoot, version, 'bin', 'claude'))
    .sort((a, b) => a.localeCompare(b))
    .reverse();
}

/**
 * Collect NVM for Windows (nvm-windows) candidates.
 * nvm-windows stores Node versions under %APPDATA%\nvm\<version>\.
 */
async function collectNvmWindowsCandidates(): Promise<string[]> {
  const appdata = process.env.APPDATA;
  if (!appdata) return [];

  const nvmRoot = path.join(appdata, 'nvm');
  let versions: string[];
  try {
    versions = await fs.promises.readdir(nvmRoot);
  } catch {
    return [];
  }

  const exts = getWindowsExecutableExtensions();
  return versions
    .toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))
    .flatMap((version) => exts.map((ext) => path.join(nvmRoot, version, `claude${ext}`)));
}

async function resolveFromPathEnv(binaryName: string, pathEnv?: string): Promise<string | null> {
  const rawPath = pathEnv && pathEnv.length > 0 ? pathEnv : process.env.PATH;
  if (!rawPath) {
    return null;
  }

  const pathParts = rawPath.split(path.delimiter);
  const binaryNames =
    process.platform === 'win32' ? expandWindowsBinaryNames(binaryName) : [binaryName];

  // Check all PATH directories in parallel. Each directory checks all extension
  // variants concurrently. This turns N_dirs × N_exts sequential stat() calls
  // into a single parallel batch, dramatically reducing startup time on Windows.
  const dirResults = await Promise.all(
    pathParts.map(async (part) => {
      if (!part) return null;
      const cleanedPart = stripSurroundingQuotes(part);
      if (!cleanedPart) return null;

      const candidates = binaryNames.map((name) => path.join(cleanedPart, name));
      const results = await Promise.all(
        candidates.map(async (candidate) => ({
          path: candidate,
          ok: await isExecutable(candidate),
        }))
      );
      // Return the first matching extension variant within this directory
      return results.find((r) => r.ok)?.path ?? null;
    })
  );

  // Return first non-null result, preserving PATH priority order
  return dirResults.find((r) => r !== null) ?? null;
}

async function resolveFromExplicitPath(inputPath: string): Promise<string | null> {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    return null;
  }

  if (process.platform === 'win32' && !path.extname(trimmed)) {
    for (const ext of getWindowsExecutableExtensions()) {
      const candidate = `${trimmed}${ext}`;
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  if (await isExecutable(trimmed)) {
    return trimmed;
  }

  return null;
}

async function resolveFromCandidateList(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function resolveFromDoctorFallback(commandName: string): Promise<string | null> {
  const candidates = await getDoctorInvokedCandidates(commandName);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    const resolved = await resolveFromExplicitPath(candidate);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

async function resolveBundledOrchestratorBinary(): Promise<string | null> {
  const resourcesPath = process.resourcesPath?.trim();
  if (!resourcesPath) {
    return null;
  }

  const binaryName = process.platform === 'win32' ? 'claude-multimodel.exe' : 'claude-multimodel';
  return resolveFromCandidateList([path.join(resourcesPath, 'runtime', binaryName)]);
}

let cachedPath: string | null | undefined;

/** Timestamp of last successful cache verification (ms). */
let cacheVerifiedAt = 0;

/** Re-verify cached binary at most once per 30 seconds. */
const CACHE_VERIFY_TTL_MS = 30_000;

/** Coalesce concurrent first resolves so `cachedPath` is not torn by parallel scans. */
let resolveInFlight: Promise<string | null> | null = null;

export class ClaudeBinaryResolver {
  /**
   * Clear the cached binary path.
   * Call after CLI install/update so the next resolve() picks up the new location.
   */
  static clearCache(): void {
    cachedPath = undefined;
    cacheVerifiedAt = 0;
  }

  static async resolve(): Promise<string | null> {
    if (cachedPath !== undefined) {
      const now = Date.now();
      // Re-verify the cached binary still exists, but at most once per TTL
      if (cachedPath !== null && now - cacheVerifiedAt > CACHE_VERIFY_TTL_MS) {
        if (await isExecutable(cachedPath)) {
          cacheVerifiedAt = now;
          return cachedPath;
        }
        cachedPath = undefined;
        cacheVerifiedAt = 0;
        // Fall through to full resolution below
      } else {
        return cachedPath;
      }
    }
    if (!resolveInFlight) {
      resolveInFlight = ClaudeBinaryResolver.runResolve().finally(() => {
        resolveInFlight = null;
      });
    }
    return resolveInFlight;
  }

  private static async runResolve(): Promise<string | null> {
    await resolveInteractiveShellEnv();
    const enrichedPath = buildMergedCliPath(null);
    const flavor = getConfiguredCliFlavor();

    const overrideRaw =
      flavor === 'agent_teams_orchestrator'
        ? (process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() ??
          process.env.CLAUDE_CLI_PATH?.trim())
        : process.env.CLAUDE_CLI_PATH?.trim();
    if (overrideRaw) {
      const looksLikePath =
        path.isAbsolute(overrideRaw) || overrideRaw.includes('\\') || overrideRaw.includes('/');
      const resolvedOverride = looksLikePath
        ? await resolveFromExplicitPath(overrideRaw)
        : await resolveFromPathEnv(overrideRaw, enrichedPath);

      if (resolvedOverride) {
        cachedPath = resolvedOverride;
        cacheVerifiedAt = Date.now();
        return cachedPath;
      }
    }

    if (flavor === 'agent_teams_orchestrator') {
      const bundledBinary = await resolveBundledOrchestratorBinary();
      if (bundledBinary) {
        cachedPath = bundledBinary;
        cacheVerifiedAt = Date.now();
        return cachedPath;
      }

      // Keep agent_teams_orchestrator resolution generic. Dev flows should
      // inject an explicit CLI path, while non-dev setups can expose
      // claude-multimodel on PATH without making this resolver guess a sibling
      // repo name or folder.
      const orchestratorBinaryName = 'claude-multimodel';
      const fromPath = await resolveFromPathEnv(orchestratorBinaryName, enrichedPath);
      if (fromPath) {
        cachedPath = fromPath;
        cacheVerifiedAt = Date.now();
        return cachedPath;
      }

      const fromDoctor = await resolveFromDoctorFallback(orchestratorBinaryName);
      if (fromDoctor) {
        cachedPath = fromDoctor;
        cacheVerifiedAt = Date.now();
        return cachedPath;
      }

      // agent_teams_orchestrator mode is explicit. If the configured local
      // runtime is missing, fail closed instead of silently falling back to a
      // different CLI.
      return null;
    }

    const baseBinaryName = 'claude';
    const fromPath = await resolveFromPathEnv(baseBinaryName, enrichedPath);
    if (fromPath) {
      cachedPath = fromPath;
      cacheVerifiedAt = Date.now();
      return cachedPath;
    }

    const platformBinaryNames =
      process.platform === 'win32' ? expandWindowsBinaryNames(baseBinaryName) : [baseBinaryName];

    const home = getShellPreferredHome();
    const vendorBinDir = path.join(getClaudeBasePath(), 'local', 'node_modules', '.bin');
    const candidateDirs: string[] =
      process.platform === 'win32'
        ? [
            // Windows: Claude npm-local vendor install
            vendorBinDir,
            // Windows: npm global install
            path.join(home, 'AppData', 'Roaming', 'npm'),
            // Windows: scoop, chocolatey, and other package managers
            path.join(home, 'scoop', 'shims'),
            // Windows: Local programs
            ...(process.env.LOCALAPPDATA
              ? [path.join(process.env.LOCALAPPDATA, 'Programs', 'claude')]
              : []),
            // Windows: Program Files
            ...(process.env.ProgramFiles ? [path.join(process.env.ProgramFiles, 'claude')] : []),
          ]
        : [
            // Unix: Claude npm-local vendor install
            vendorBinDir,
            // Unix: native binary installation path (claude install)
            path.join(home, '.local', 'bin'),
            path.join(home, '.npm-global', 'bin'),
            path.join(home, '.npm', 'bin'),
            '/usr/local/bin',
            '/opt/homebrew/bin',
          ];

    const candidates = candidateDirs.flatMap((dir) =>
      platformBinaryNames.map((name) => path.join(dir, name))
    );

    const nvmCandidates = await collectNvmCandidates();
    const allCandidates = [...candidates, ...nvmCandidates];

    // Check all fallback candidates in parallel for speed
    const results = await Promise.all(
      allCandidates.map(async (candidate) => ({
        path: candidate,
        ok: await isExecutable(candidate),
      }))
    );
    // Return first match, preserving candidate priority order
    const found = results.find((r) => r.ok);
    if (found) {
      cachedPath = found.path;
      cacheVerifiedAt = Date.now();
      return cachedPath;
    }

    const fromDoctor = await resolveFromDoctorFallback(baseBinaryName);
    if (fromDoctor) {
      cachedPath = fromDoctor;
      cacheVerifiedAt = Date.now();
      return cachedPath;
    }

    // Don't cache null — CLI may be installed later without app restart
    return null;
  }
}
