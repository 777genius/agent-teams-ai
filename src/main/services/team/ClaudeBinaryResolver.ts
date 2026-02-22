import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
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
  for (const part of pathParts) {
    if (!part) {
      continue;
    }

    const candidate = path.join(part, binaryName);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

let cachedPath: string | null | undefined;

export class ClaudeBinaryResolver {
  static async resolve(): Promise<string | null> {
    if (cachedPath !== undefined) return cachedPath;

    const platformBinaryName = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    const fromPath = await resolveFromPathEnv(platformBinaryName);
    if (fromPath) {
      cachedPath = fromPath;
      return cachedPath;
    }

    const candidates: string[] = [
      path.join(os.homedir(), '.npm-global', 'bin', platformBinaryName),
      path.join(os.homedir(), '.npm', 'bin', platformBinaryName),
      process.platform === 'win32'
        ? path.join(process.env.APPDATA ?? '', 'npm', 'claude.cmd')
        : '/usr/local/bin/claude',
      process.platform === 'win32' ? '' : '/opt/homebrew/bin/claude',
    ].filter((candidate) => candidate.length > 0);

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
