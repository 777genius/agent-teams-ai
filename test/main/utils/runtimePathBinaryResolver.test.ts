import { chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const buildMergedCliPathMock = vi.hoisted(() => vi.fn(() => ''));
const getCachedShellEnvMock = vi.hoisted(() => vi.fn<() => NodeJS.ProcessEnv | null>(() => null));

vi.mock('@main/utils/cliPathMerge', () => ({
  buildMergedCliPath: buildMergedCliPathMock,
}));

vi.mock('@main/utils/shellEnv', () => ({
  getCachedShellEnv: getCachedShellEnvMock,
}));

import {
  collectRuntimePathBinaryCandidates,
  findFirstRuntimePathBinaryCandidate,
  RUNTIME_PATH_SHELL_ENV_TIMEOUT_MS,
} from '@main/utils/runtimePathBinaryResolver';

describe('runtimePathBinaryResolver', () => {
  let tempRoot: string | null = null;
  let originalPath: string | undefined;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'runtime-path-binary-resolver-'));
    originalPath = process.env.PATH;
    process.env.PATH = '';
    buildMergedCliPathMock.mockReset();
    buildMergedCliPathMock.mockReturnValue('');
    getCachedShellEnvMock.mockReset();
    getCachedShellEnvMock.mockReturnValue(null);
  });

  afterEach(async () => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  async function createExecutable(dirName: string, name: string): Promise<string> {
    const binaryPath = path.join(tempRoot!, dirName, name);
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary');
    if (process.platform !== 'win32') {
      await chmod(binaryPath, 0o755);
    }
    return binaryPath;
  }

  it('prefers explicit env sources before cached and fallback PATH entries', async () => {
    const explicitBinary = await createExecutable('explicit-bin', 'tool');
    const cachedBinary = await createExecutable('cached-bin', 'tool');
    const fallbackBinary = await createExecutable('fallback-bin', 'tool');
    getCachedShellEnvMock.mockReturnValue({ PATH: path.dirname(cachedBinary) });
    buildMergedCliPathMock.mockReturnValue(path.dirname(fallbackBinary));

    expect(
      findFirstRuntimePathBinaryCandidate({
        executableNames: ['tool'],
        additionalEnvSources: [{ PATH: path.dirname(explicitBinary) }],
      })
    ).toBe(explicitBinary);
  });

  it('keeps extra candidates before fallback PATH entries and filters missing files', async () => {
    const extraBinary = await createExecutable('extra-bin', 'tool');
    const fallbackBinary = await createExecutable('fallback-bin', 'tool');
    buildMergedCliPathMock.mockReturnValue(path.dirname(fallbackBinary));

    expect(
      collectRuntimePathBinaryCandidates({
        executableNames: ['tool'],
        extraCandidates: [path.join(tempRoot!, 'missing', 'tool'), extraBinary],
      })
    ).toEqual([extraBinary, fallbackBinary]);
  });

  it('can skip fallback PATH entries for staged shell-env lookup', async () => {
    const fallbackBinary = await createExecutable('fallback-bin', 'tool');
    buildMergedCliPathMock.mockReturnValue(path.dirname(fallbackBinary));

    expect(
      collectRuntimePathBinaryCandidates({
        executableNames: ['tool'],
        includeFallbackPathEntries: false,
      })
    ).toEqual([]);
    expect(RUNTIME_PATH_SHELL_ENV_TIMEOUT_MS).toBe(1_500);
  });
});
