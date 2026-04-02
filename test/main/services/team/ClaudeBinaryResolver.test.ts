// @vitest-environment node
import type { PathLike } from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockBuildMergedCliPath = vi.fn<(binaryPath: string | null) => string>();
const mockGetShellPreferredHome = vi.fn<() => string>();
const mockResolveInteractiveShellEnv = vi.fn<() => Promise<NodeJS.ProcessEnv>>();
const mockGetConfiguredCliFlavor = vi.fn<() => 'claude' | 'free-code'>();

const accessMock = vi.fn<(filePath: PathLike, mode?: number) => Promise<void>>();
const statMock = vi.fn<
  (filePath: PathLike) => Promise<{ isFile: () => boolean }>
>();
const readdirMock = vi.fn<(filePath: PathLike) => Promise<string[]>>();

vi.mock('@main/utils/cliPathMerge', () => ({
  buildMergedCliPath: (binaryPath: string | null) => mockBuildMergedCliPath(binaryPath),
}));

vi.mock('@main/utils/shellEnv', () => ({
  getShellPreferredHome: () => mockGetShellPreferredHome(),
  resolveInteractiveShellEnv: () => mockResolveInteractiveShellEnv(),
}));

vi.mock('@main/services/team/cliFlavor', () => ({
  getConfiguredCliFlavor: () => mockGetConfiguredCliFlavor(),
}));

vi.mock('fs', () => ({
  default: {
    constants: { X_OK: 1 },
    promises: {
      access: (filePath: PathLike, mode?: number) => accessMock(filePath, mode),
      stat: (filePath: PathLike) => statMock(filePath),
      readdir: (filePath: PathLike) => readdirMock(filePath),
    },
  },
  constants: { X_OK: 1 },
  promises: {
    access: (filePath: PathLike, mode?: number) => accessMock(filePath, mode),
    stat: (filePath: PathLike) => statMock(filePath),
    readdir: (filePath: PathLike) => readdirMock(filePath),
  },
}));

describe('ClaudeBinaryResolver', () => {
  const originalPlatform = process.platform;
  const originalCwd = process.cwd;
  const workspaceRoot = '/Users/belief/dev/projects/claude/claude_team_freecode';

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockBuildMergedCliPath.mockReturnValue('/usr/local/bin:/usr/bin');
    mockGetShellPreferredHome.mockReturnValue('/Users/tester');
    mockResolveInteractiveShellEnv.mockResolvedValue({});
    mockGetConfiguredCliFlavor.mockReturnValue('free-code');
    readdirMock.mockResolvedValue([]);
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
      writable: true,
    });
    process.cwd = vi.fn(() => workspaceRoot);
    delete process.env.CLAUDE_CLI_PATH;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
      writable: true,
    });
    process.cwd = originalCwd;
    vi.unstubAllEnvs();
  });

  it('resolves free-code runtime from the free-code-gemini-research sibling repo', async () => {
    const expectedBinary = '/Users/belief/dev/projects/claude/free-code-gemini-research/cli';

    accessMock.mockImplementation(async (filePath) => {
      if (filePath === expectedBinary) {
        return;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const { ClaudeBinaryResolver } = await import('@main/services/team/ClaudeBinaryResolver');
    ClaudeBinaryResolver.clearCache();

    await expect(ClaudeBinaryResolver.resolve()).resolves.toBe(expectedBinary);
    expect(accessMock).toHaveBeenCalledWith(expectedBinary, 1);
  });
});
