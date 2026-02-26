import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
  const nvmNodeRoot = path.join(os.homedir(), '.nvm', 'versions', 'node');
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

async function resolveFromPathEnv(binaryName: string): Promise<string | null> {
  const rawPath = process.env.PATH;
  if (!rawPath) {
    return null;
  }

  const pathParts = rawPath.split(path.delimiter);
  const binaryNames =
    process.platform === 'win32' ? expandWindowsBinaryNames(binaryName) : [binaryName];
  for (const part of pathParts) {
    if (!part) {
      continue;
    }

    const cleanedPart = stripSurroundingQuotes(part);
    if (!cleanedPart) {
      continue;
    }

    for (const name of binaryNames) {
      const candidate = path.join(cleanedPart, name);
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function resolveFromExplicitPath(inputPath: string): Promise<string | null> {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    return null;
  }

  if (await isExecutable(trimmed)) {
    return trimmed;
  }

  if (process.platform !== 'win32') {
    return null;
  }

  if (path.extname(trimmed)) {
    return null;
  }

  for (const ext of getWindowsExecutableExtensions()) {
    const candidate = `${trimmed}${ext}`;
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

let cachedPath: string | null | undefined;

export class ClaudeBinaryResolver {
  /**
   * Clear the cached binary path.
   * Call after CLI install/update so the next resolve() picks up the new location.
   */
  static clearCache(): void {
    cachedPath = undefined;
  }

  static async resolve(): Promise<string | null> {
    if (cachedPath !== undefined) return cachedPath;

    const overrideRaw = process.env.CLAUDE_CLI_PATH?.trim();
    if (overrideRaw) {
      const looksLikePath =
        path.isAbsolute(overrideRaw) || overrideRaw.includes('\\') || overrideRaw.includes('/');
      const resolvedOverride = looksLikePath
        ? await resolveFromExplicitPath(overrideRaw)
        : await resolveFromPathEnv(overrideRaw);

      if (resolvedOverride) {
        cachedPath = resolvedOverride;
        return cachedPath;
      }
    }

    const baseBinaryName = 'claude';
    const fromPath = await resolveFromPathEnv(baseBinaryName);
    if (fromPath) {
      cachedPath = fromPath;
      return cachedPath;
    }

    const platformBinaryNames =
      process.platform === 'win32' ? expandWindowsBinaryNames(baseBinaryName) : [baseBinaryName];

    const candidateDirs: string[] = [
      // Native binary installation path (claude install)
      path.join(os.homedir(), '.local', 'bin'),
      path.join(os.homedir(), '.npm-global', 'bin'),
      path.join(os.homedir(), '.npm', 'bin'),
      process.platform === 'win32'
        ? process.env.APPDATA
          ? path.join(process.env.APPDATA, 'npm')
          : ''
        : '/usr/local/bin',
      process.platform === 'win32' ? '' : '/opt/homebrew/bin',
    ].filter((candidate) => candidate.length > 0);

    const candidates = candidateDirs.flatMap((dir) =>
      platformBinaryNames.map((name) => path.join(dir, name))
    );

    const nvmCandidates = process.platform === 'win32' ? [] : await collectNvmCandidates();
    for (const candidate of [...candidates, ...nvmCandidates]) {
      if (await isExecutable(candidate)) {
        cachedPath = candidate;
        return cachedPath;
      }
    }

    // Don't cache null — CLI may be installed later without app restart
    return null;
  }
}
