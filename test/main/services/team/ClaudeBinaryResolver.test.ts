// @vitest-environment node
import type { PathLike } from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockBuildMergedCliPath = vi.fn<(binaryPath: string | null) => string>();
const mockGetShellPreferredHome = vi.fn<() => string>();
const mockResolveInteractiveShellEnv = vi.fn<() => Promise<NodeJS.ProcessEnv>>();
const mockGetConfiguredCliFlavor = vi.fn<() => 'claude' | 'free-code'>();

const accessMock = vi.fn<(filePath: PathLike, mode?: number) => Promise<void>>();
const statMock = vi.fn<(filePath: PathLike) => Promise<{ isFile: () => boolean }>>();

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
    },
  },
  constants: { X_OK: 1 },
  promises: {
    access: (filePath: PathLike, mode?: number) => accessMock(filePath, mode),
    stat: (filePath: PathLike) => statMock(filePath),
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
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
      writable: true,
    });
    process.cwd = vi.fn(() => workspaceRoot);
    delete process.env.CLAUDE_CLI_PATH;
    delete process.env.CLAUDE_FREE_CODE_CLI_PATH;
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

  it('resolves free-code runtime from an explicit CLAUDE_CLI_PATH override', async () => {
    const expectedBinary = '/Users/belief/dev/projects/claude/free-code-gemini-research/cli-dev';
    process.env.CLAUDE_CLI_PATH = expectedBinary;

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

  it('prefers the dedicated CLAUDE_FREE_CODE_CLI_PATH override in free-code mode', async () => {
    const expectedBinary = '/Users/belief/dev/projects/claude/free-code-gemini-research/cli-dev';
    process.env.CLAUDE_FREE_CODE_CLI_PATH = expectedBinary;

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

  it('ignores CLAUDE_FREE_CODE_CLI_PATH when Claude flavor is selected', async () => {
    process.env.CLAUDE_FREE_CODE_CLI_PATH =
      '/Users/belief/dev/projects/claude/free-code-gemini-research/cli-dev';
    mockGetConfiguredCliFlavor.mockReturnValue('claude');
    const expectedBinary = '/usr/local/bin/claude';

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

  it('falls back to claude-multimodel on PATH for free-code runtime', async () => {
    const expectedBinary = '/usr/local/bin/claude-multimodel';

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
