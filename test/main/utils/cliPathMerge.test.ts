import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetCachedShellEnv = vi.fn<() => Record<string, string> | null>();
const mockGetShellPreferredHome = vi.fn<() => string>();
const mockGetClaudeBasePath = vi.fn<() => string>();

vi.mock('@main/utils/shellEnv', () => ({
  getCachedShellEnv: () => mockGetCachedShellEnv(),
  getShellPreferredHome: () => mockGetShellPreferredHome(),
}));

vi.mock('@main/utils/pathDecoder', () => ({
  getClaudeBasePath: () => mockGetClaudeBasePath(),
}));

describe('buildMergedCliPath', () => {
  let buildMergedCliPath: typeof import('@main/utils/cliPathMerge').buildMergedCliPath;
  const originalPlatform = process.platform;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const originalProgramFiles = process.env.ProgramFiles;
  const originalPath = process.env.PATH;

  beforeEach(async () => {
    vi.resetModules();
    mockGetShellPreferredHome.mockReturnValue('/home/testuser');
    mockGetCachedShellEnv.mockReturnValue(null);
    mockGetClaudeBasePath.mockReturnValue('/home/testuser/.claude');
    process.env.PATH = '/usr/bin';
    ({ buildMergedCliPath } = await import('@main/utils/cliPathMerge'));
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalLocalAppData === undefined) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = originalLocalAppData;
    }
    if (originalProgramFiles === undefined) {
      delete process.env.ProgramFiles;
    } else {
      process.env.ProgramFiles = originalProgramFiles;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  });

  it('on darwin/linux with cold shell cache prepends standard user bin dirs before process PATH', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const p = buildMergedCliPath(null);
    expect(p.split(':')).toEqual(
      expect.arrayContaining([
        '/home/testuser/.claude/local/node_modules/.bin',
        '/home/testuser/.bun/bin',
        '/home/testuser/.local/bin',
        '/home/testuser/.npm-global/bin',
        '/home/testuser/.npm/bin',
        '/home/testuser/.asdf/shims',
        '/home/testuser/.local/share/mise/shims',
        '/home/testuser/.volta/bin',
        '/home/testuser/Library/pnpm',
        '/home/testuser/.local/share/pnpm',
        '/home/testuser/.cargo/bin',
        '/home/testuser/.nix-profile/bin',
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/opt/local/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ])
    );
    expect(p.startsWith('/home/testuser/.claude/local/node_modules/.bin')).toBe(true);
    expect(p.split(':').filter((part) => part === '/usr/bin')).toHaveLength(1);
  });

  it('on win32 with cold shell cache uses semicolon and npm-style dirs', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mockGetShellPreferredHome.mockReturnValue('C:\\Users\\testuser');
    process.env.LOCALAPPDATA = 'C:\\Users\\testuser\\AppData\\Local';
    process.env.ProgramFiles = 'C:\\Program Files';
    const p = buildMergedCliPath(null);
    const parts = p.split(';');
    expect(parts.some((x) => /Roaming[/\\]npm/i.test(x))).toBe(true);
    expect(parts.some((x) => /Programs[/\\]claude/i.test(x))).toBe(true);
    expect(parts.some((x) => /AppData[/\\]Local[/\\]pnpm/i.test(x))).toBe(true);
    expect(parts.some((x) => /[.]volta[/\\]bin/i.test(x))).toBe(true);
    expect(parts.some((x) => /Program Files[/\\]nodejs/i.test(x))).toBe(true);
    expect(parts[parts.length - 1]).toBe('/usr/bin');
  });

  it('when shell cache has PATH, keeps it first and still adds static fallback dirs', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockGetCachedShellEnv.mockReturnValue({ PATH: '/opt/custom/bin:/bin' });
    const p = buildMergedCliPath(null);
    expect(p.startsWith('/opt/custom/bin')).toBe(true);
    expect(p).toContain('/bin');
    expect(p).toContain('/home/testuser/.claude/local/node_modules/.bin');
    expect(p).toContain('/home/testuser/.bun/bin');
    expect(p).toContain('/home/testuser/.local/bin');
    expect(p).toContain('/usr/local/bin');
    expect(p).toContain('/usr/bin');
  });

  it('prepends binary directory when binaryPath is set', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockGetCachedShellEnv.mockReturnValue({ PATH: '/x/bin' });
    const p = buildMergedCliPath('/opt/node/bin/claude');
    expect(p.startsWith('/opt/node/bin')).toBe(true);
  });
});
