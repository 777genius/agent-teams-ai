// @vitest-environment node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV,
  AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV,
  applyElectronDevClaudeRootOverrideForWorker,
  applyElectronDevPathOverrides,
} from './electronDevPathOverrides';
import { migrateElectronUserDataDirectory } from './electronUserDataMigration';
import { getClaudeBasePath, setAppDataBasePath, setClaudeBasePathOverride } from './pathDecoder';

describe('applyElectronDevPathOverrides', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    setClaudeBasePathOverride(null);
    setAppDataBasePath(null);
    const scratchParent = fs.realpathSync.native(os.tmpdir());
    for (const dir of tempDirs.splice(0)) {
      if (!fs.existsSync(dir)) continue;
      const target = fs.realpathSync.native(dir);
      const relative = path.relative(scratchParent, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Refusing to remove a fixture outside the temporary directory');
      }
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });

  it('applies absolute userData and Claude root overrides before Electron storage migration', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-path-overrides-'));
    tempDirs.push(tempRoot);
    const userDataDir = path.join(tempRoot, 'user-data');
    const claudeRoot = path.join(tempRoot, '.claude');
    const setPathCalls: Array<{ name: string; value: string }> = [];
    const result = applyElectronDevPathOverrides(
      {
        setPath: (name, value) => setPathCalls.push({ name, value }),
      },
      {
        [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: userDataDir,
        [AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]: claudeRoot,
      }
    );

    expect(result).toEqual({
      userDataDir,
      claudeRoot,
      warnings: [],
    });
    expect(setPathCalls).toEqual([
      {
        name: 'userData',
        value: userDataDir,
      },
      { name: 'sessionData', value: userDataDir },
      { name: 'logs', value: path.join(userDataDir, 'logs') },
      { name: 'crashDumps', value: path.join(userDataDir, 'crashes') },
    ]);
    expect(getClaudeBasePath()).toBe(claudeRoot);
    for (const { value } of setPathCalls) {
      expect(fs.statSync(value).isDirectory()).toBe(true);
    }
    expect(fs.existsSync(claudeRoot)).toBe(true);
  });

  it('fails closed for an explicit relative userData path', () => {
    const setPathCalls: Array<{ name: string; value: string }> = [];
    expect(() =>
      applyElectronDevPathOverrides(
        { setPath: (name, value) => setPathCalls.push({ name, value }) },
        { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: 'relative-user-data' }
      )
    ).toThrow(`${AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV} must be an absolute path.`);
    expect(setPathCalls).toEqual([]);
  });

  it.each(['', '  '])('fails closed for an explicitly empty userData path', (value) => {
    const setPath = vi.fn();
    expect(() =>
      applyElectronDevPathOverrides(
        { setPath },
        { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: value }
      )
    ).toThrow('must be an absolute path');
    expect(setPath).not.toHaveBeenCalled();
  });

  it('rejects a dev root that aliases the regular profile before creating children', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-path-regular-'));
    tempDirs.push(tempRoot);
    const regular = path.join(tempRoot, 'regular');
    const alias = path.join(tempRoot, 'alias');
    fs.mkdirSync(regular);
    fs.symlinkSync(regular, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const setPath = vi.fn();
    expect(() =>
      applyElectronDevPathOverrides(
        { setPath, getPath: () => regular },
        { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: path.join(alias, 'nested') }
      )
    ).toThrow(/overlaps regular userData/);
    expect(setPath).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(regular, 'nested'))).toBe(false);
  });

  it('uses the native canonical path to reject an alternate name for the regular profile', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-path-native-alias-'));
    tempDirs.push(tempRoot);
    const regular = path.join(tempRoot, 'regular profile');
    const alternateName = path.join(tempRoot, 'REGULA~1');
    fs.mkdirSync(regular);
    const actualNative = fs.realpathSync.native;
    const nativeSpy = vi
      .spyOn(fs.realpathSync, 'native')
      .mockImplementation(((value: fs.PathLike) =>
        path.resolve(String(value)) === alternateName
          ? actualNative(regular)
          : actualNative(value)) as typeof fs.realpathSync.native);
    const setPath = vi.fn();
    try {
      expect(() =>
        applyElectronDevPathOverrides(
          { setPath, getPath: () => regular },
          { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: alternateName }
        )
      ).toThrow(/overlaps regular userData/);
      expect(setPath).not.toHaveBeenCalled();
      expect(nativeSpy).toHaveBeenCalled();
      // Windows can genuinely resolve REGULA~1 to the existing profile via an 8.3 alias.
      // The invariant is that rejecting the alias leaves that profile untouched.
      expect(fs.readdirSync(regular)).toEqual([]);
    } finally {
      nativeSpy.mockRestore();
    }
  });

  it('rejects the legacy profile normal startup can reuse, including before it exists', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-path-legacy-'));
    tempDirs.push(tempRoot);
    const current = path.join(tempRoot, 'Agent Teams AI');
    const preferred = path.join(tempRoot, 'agent-teams-ai');
    fs.mkdirSync(current);
    const setPath = vi.fn();
    const app = {
      setPath,
      getPath: (name: string) =>
        name === 'userData' || name === 'sessionData' ? current : path.join(current, name),
    };
    const env = { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: preferred };

    expect(() => applyElectronDevPathOverrides(app, env)).toThrow(
      /overlaps regular legacy userData/
    );
    expect(fs.existsSync(preferred)).toBe(false);
    expect(setPath).not.toHaveBeenCalled();

    fs.mkdirSync(path.join(preferred, 'data'), { recursive: true });
    fs.writeFileSync(path.join(preferred, 'data', 'fixture.txt'), 'fixture');
    const normalPaths = new Map<string, string>();
    const normal = migrateElectronUserDataDirectory({
      getPath: () => current,
      setPath: (name, value) => normalPaths.set(name, value),
    });
    expect(normal.reason).toBe('legacy-reused');
    expect(normalPaths.get('userData')).toBe(preferred);
    expect(() => applyElectronDevPathOverrides(app, env)).toThrow(
      /overlaps regular legacy userData/
    );
    expect(setPath).not.toHaveBeenCalled();

    const independent = path.join(tempRoot, 'isolated-profile');
    expect(
      applyElectronDevPathOverrides(app, { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: independent })
        .userDataDir
    ).toBe(independent);
    expect(setPath).toHaveBeenCalledTimes(4);
  });

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'win32')(
    'rejects a case-only alias of a nonexistent legacy profile',
    () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-path-case-alias-'));
      tempDirs.push(tempRoot);
      const regular = path.join(tempRoot, 'Agent Teams AI');
      const alias = path.join(tempRoot, 'AGENT-TEAMS-AI');
      const setPath = vi.fn();
      expect(() =>
        applyElectronDevPathOverrides(
          {
            setPath,
            getPath: (name: string) =>
              name === 'userData' || name === 'sessionData'
                ? regular
                : path.join(regular, name),
          },
          { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: alias }
        )
      ).toThrow(/overlaps regular legacy userData/);
      expect(setPath).not.toHaveBeenCalled();
      expect(fs.existsSync(alias)).toBe(false);
    }
  );

  it('rejects an explicit Claude root inside a normal Electron profile', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-claude-profile-'));
    tempDirs.push(tempRoot);
    const regular = path.join(tempRoot, 'regular-profile');
    const claudeRoot = path.join(regular, 'data', '.claude');
    const setPath = vi.fn();
    expect(() =>
      applyElectronDevPathOverrides(
        { setPath, getPath: () => regular },
        { [AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]: claudeRoot }
      )
    ).toThrow(/Electron isolated Claude root overlaps regular userData/);
    expect(fs.existsSync(claudeRoot)).toBe(false);
    expect(setPath).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'rejects an existing isolated logs directory that is not writable',
    () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-profile-readonly-'));
      tempDirs.push(tempRoot);
      const userDataDir = path.join(tempRoot, 'isolated');
      const logs = path.join(userDataDir, 'logs');
      fs.mkdirSync(logs, { recursive: true });
      fs.chmodSync(logs, 0o500);
      const setPath = vi.fn();
      try {
        expect(() =>
          applyElectronDevPathOverrides(
            { setPath },
            { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: userDataDir }
          )
        ).toThrow(/could not be created/);
        expect(setPath).not.toHaveBeenCalled();
      } finally {
        fs.chmodSync(logs, 0o700);
      }
    }
  );

  it('rejects a junction used as the dev profile root', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-path-root-link-'));
    tempDirs.push(tempRoot);
    const target = path.join(tempRoot, 'target');
    const alias = path.join(tempRoot, 'alias');
    fs.mkdirSync(target);
    fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const setPath = vi.fn();
    expect(() =>
      applyElectronDevPathOverrides(
        { setPath },
        { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: alias }
      )
    ).toThrow(/must not be a symlink or junction/);
    expect(setPath).not.toHaveBeenCalled();
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it.each(['relative-claude-root', '', '  '])(
    'fails closed for an invalid Claude root without changing Electron paths',
    (invalidRoot) => {
      const setPathCalls: Array<{ name: string; value: string }> = [];
      expect(() =>
        applyElectronDevPathOverrides(
          { setPath: (name, value) => setPathCalls.push({ name, value }) },
          { [AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]: invalidRoot }
        )
      ).toThrow(`${AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV} must be an absolute path.`);
      expect(setPathCalls).toEqual([]);
    }
  );

  it('rejects an uncreatable explicit Claude root before changing Electron paths', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-claude-blocked-'));
    tempDirs.push(tempRoot);
    const claudeRoot = path.join(tempRoot, 'blocked');
    fs.writeFileSync(claudeRoot, 'file');
    const setPath = vi.fn();
    expect(() =>
      applyElectronDevPathOverrides(
        { setPath },
        {
          [AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]: claudeRoot,
          [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: path.join(tempRoot, 'profile'),
        }
      )
    ).toThrow(/could not be created/);
    expect(setPath).not.toHaveBeenCalled();
  });

  it('rejects an invalid explicit Claude root inside worker startup too', () => {
    expect(() =>
      applyElectronDevClaudeRootOverrideForWorker({ [AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]: '' })
    ).toThrow(/must be an absolute path/);
  });

  it('rejects an uncreatable Claude root inside worker startup', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-worker-blocked-'));
    tempDirs.push(tempRoot);
    const claudeRoot = path.join(tempRoot, 'blocked');
    fs.writeFileSync(claudeRoot, 'file');
    expect(() =>
      applyElectronDevClaudeRootOverrideForWorker({
        [AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]: claudeRoot,
      })
    ).toThrow(/could not be created/);
  });

  it.each([
    ['userData', null],
    ['logs', 'logs'],
    ['crashDumps', 'crashes'],
  ])('fails before changing Electron paths when %s cannot be created', (_name, suffix) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-path-blocked-'));
    tempDirs.push(tempRoot);
    const userDataDir = path.join(tempRoot, 'user-data');
    if (suffix !== null) fs.mkdirSync(userDataDir);
    fs.writeFileSync(suffix === null ? userDataDir : path.join(userDataDir, suffix), 'blocked');
    const setPathCalls: Array<{ name: string; value: string }> = [];

    expect(() =>
      applyElectronDevPathOverrides(
        { setPath: (name, value) => setPathCalls.push({ name, value }) },
        { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: userDataDir }
      )
    ).toThrow(/could not be created/);
    expect(setPathCalls).toEqual([]);
  });

  it('rejects an isolated subdirectory that redirects outside userData', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-path-link-'));
    tempDirs.push(tempRoot);
    const userDataDir = path.join(tempRoot, 'user-data');
    const redirectedDir = path.join(tempRoot, 'redirected');
    fs.mkdirSync(userDataDir);
    fs.mkdirSync(redirectedDir);
    fs.symlinkSync(
      redirectedDir,
      path.join(userDataDir, 'logs'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const setPathCalls: Array<{ name: string; value: string }> = [];

    expect(() =>
      applyElectronDevPathOverrides(
        { setPath: (name, value) => setPathCalls.push({ name, value }) },
        { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: userDataDir }
      )
    ).toThrow(/logs must be a real directory/);
    expect(setPathCalls).toEqual([]);
  });

  it('requires the Electron path API for an explicit userData override', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-no-path-api-'));
    tempDirs.push(tempRoot);
    expect(() =>
      applyElectronDevPathOverrides(
        {},
        { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: path.join(tempRoot, 'user-data') }
      )
    ).toThrow('Electron path overrides require app.setPath');
  });

  it('does not change Electron paths when no override is requested', () => {
    const setPathCalls: Array<{ name: string; value: string }> = [];
    const result = applyElectronDevPathOverrides(
      { setPath: (name, value) => setPathCalls.push({ name, value }) },
      {}
    );
    expect(result).toEqual({ userDataDir: null, claudeRoot: null, warnings: [] });
    expect(setPathCalls).toEqual([]);
  });

  it('applies the explicit Claude root inside worker-thread startup', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-worker-root-'));
    tempDirs.push(tempRoot);
    const claudeRoot = path.join(tempRoot, '.claude');

    const result = applyElectronDevClaudeRootOverrideForWorker({
      [AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]: claudeRoot,
    });

    expect(result).toBe(claudeRoot);
    expect(getClaudeBasePath()).toBe(claudeRoot);
  });
});
