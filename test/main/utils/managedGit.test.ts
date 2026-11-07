import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createManagedGitEnv, getManagedGitExecutable } from '@main/utils/managedGit';

const directories: string[] = [];

async function fixture(target: string): Promise<string> {
  const base = await mkdtemp(path.join(tmpdir(), 'managed-git-'));
  directories.push(base);
  const root = path.join(base, 'git');
  const binary = path.join(root, target.startsWith('win32') ? 'cmd/git.exe' : 'bin/git');
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, 'fake Git binary');
  await writeFile(path.join(root, 'MANAGED_GIT.json'), JSON.stringify({
    platform: target,
    sha256: 'a'.repeat(64),
  }));
  await writeFile(path.join(base, 'app.asar'), '');
  return base;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

describe('managed Git desktop resolution', () => {
  it('uses bundled Git on an installed macOS app without invoking system Git', async () => {
    const resourcesPath = await fixture('darwin-arm64');
    const opts = { resourcesPath, platform: 'darwin' as const, arch: 'arm64' };
    const env = { PATH: '/usr/bin:/bin', HOME: '/Users/test', GIT_CONFIG_GLOBAL: '/test/config' };
    const result = createManagedGitEnv(env, opts);

    expect(getManagedGitExecutable(opts)).toBe(path.join(resourcesPath, 'git/bin/git'));
    expect(result.PATH?.split(':')[0]).toBe(path.join(resourcesPath, 'git/bin'));
    expect(result.GIT_EXEC_PATH).toBe(path.join(resourcesPath, 'git/libexec/git-core'));
    expect(result.GIT_CONFIG_SYSTEM).toBe(path.join(resourcesPath, 'git/etc/gitconfig'));
    expect(result.GIT_CONFIG_GLOBAL).toBe('/test/config');
    expect(result.HOME).toBe('/Users/test');
    expect(env.PATH).toBe('/usr/bin:/bin');
  });

  it('preserves user-specified Git configuration on macOS', async () => {
    const resourcesPath = await fixture('darwin-x64');
    const env = createManagedGitEnv(
      { PATH: '/usr/bin', GIT_CONFIG_SYSTEM: '/custom/gitconfig', GIT_TEMPLATE_DIR: '/custom/templates' },
      { resourcesPath, platform: 'darwin', arch: 'x64' }
    );
    expect(env.GIT_CONFIG_SYSTEM).toBe('/custom/gitconfig');
    expect(env.GIT_TEMPLATE_DIR).toBe('/custom/templates');
  });

  it.each(['win32-x64', 'win32-arm64'] as const)(
    'uses the correct Git for Windows layout for %s',
    async (target) => {
      const resourcesPath = await fixture(target);
      const arch = target.split('-')[1];
      const env = createManagedGitEnv(
        { Path: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\tester' },
        { resourcesPath, platform: 'win32', arch }
      );
      const flavor = arch === 'arm64' ? 'clangarm64' : 'ucrt64';
      expect(env.PATH?.split(';')[0]).toBe(path.join(resourcesPath, 'git/cmd'));
      expect(env.PATH).toContain(path.join(resourcesPath, 'git', flavor, 'bin'));
      expect(env.GIT_EXEC_PATH).toBe(path.join(resourcesPath, 'git', flavor, 'libexec', 'git-core'));
      expect(env.Path).toBeUndefined();
      expect(env.USERPROFILE).toBe('C:\\Users\\tester');
    }
  );

  it('provides Git CA and PREFIX for bundled Linux', async () => {
    const resourcesPath = await fixture('linux-x64');
    const env = createManagedGitEnv({ PATH: '/usr/bin' }, { resourcesPath, platform: 'linux', arch: 'x64' });
    expect(env.PREFIX).toBeUndefined();
    expect(env.GIT_SSL_CAINFO).toBeUndefined();
    const direct = createManagedGitEnv({ PATH: '/usr/bin' }, {
      resourcesPath, platform: 'linux', arch: 'x64', gitCommand: true,
    });
    expect(direct.PREFIX).toBe(path.join(resourcesPath, 'git'));
  });

  it('prefers the final PATH over stale Path aliases on Windows', async () => {
    const resourcesPath = await fixture('win32-x64');
    const env = createManagedGitEnv({
      Path: 'C:\\stale',
      PATH: 'C:\\current;C:\\tools',
    }, { resourcesPath, platform: 'win32', arch: 'x64' });
    expect(env.PATH).toContain('C:\\current');
    expect(env.PATH).toContain('C:\\tools');
    expect(env.PATH).not.toContain('C:\\stale');
    expect(env.Path).toBeUndefined();
  });

  it('does not block non-Git launch environments when a packaged runtime is missing', async () => {
    const resourcesPath = await mkdtemp(path.join(tmpdir(), 'managed-git-missing-env-'));
    directories.push(resourcesPath);
    await writeFile(path.join(resourcesPath, 'app.asar'), '');
    const original = { PATH: '/usr/bin:/bin', HOME: '/Users/test' };
    expect(createManagedGitEnv(original, { resourcesPath, platform: 'darwin', arch: 'arm64' }))
      .toEqual(original);
  });

  it('never falls back to the macOS installer shim if packaged Git is missing', async () => {
    const resourcesPath = await mkdtemp(path.join(tmpdir(), 'managed-git-missing-'));
    directories.push(resourcesPath);
    await writeFile(path.join(resourcesPath, 'app.asar'), '');
    expect(() => getManagedGitExecutable({ resourcesPath, platform: 'darwin', arch: 'arm64' }))
      .toThrow('bundled Git is missing or invalid');
  });

  it('keeps source checkout development possible without a staged distribution', async () => {
    const developmentRoot = await mkdtemp(path.join(tmpdir(), 'managed-git-dev-'));
    directories.push(developmentRoot);
    expect(getManagedGitExecutable({ developmentRoot, packaged: false })).toBe('git');
  });
});
