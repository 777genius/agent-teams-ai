import { describe, expect, it } from 'vitest';

import {
  buildWorkspaceTrustPathCandidates,
  collectWorkspaceTrustParentConfigKeys,
  getWorkspaceTrustNonPersistableReason,
  normalizeWorkspaceTrustComparisonKey,
  normalizeWorkspaceTrustConfigKey,
} from '@features/workspace-trust/core/domain';

describe('WorkspaceTrustPath', () => {
  it('normalizes runtime-compatible config keys without lowercasing POSIX paths', () => {
    expect(normalizeWorkspaceTrustConfigKey('/Tmp/Repo/', { platform: 'posix' })).toBe('/Tmp/Repo');
    expect(normalizeWorkspaceTrustComparisonKey('/Tmp/Repo', { platform: 'posix' })).toBe(
      '/Tmp/Repo'
    );
    expect(normalizeWorkspaceTrustComparisonKey('/tmp/repo', { platform: 'posix' })).not.toBe(
      normalizeWorkspaceTrustComparisonKey('/Tmp/Repo', { platform: 'posix' })
    );
  });

  it('dedupes Windows drive-letter and separator variants for comparison only', () => {
    expect(normalizeWorkspaceTrustConfigKey('C:\\Repo\\Sub\\', { platform: 'win32' })).toBe(
      'C:/Repo/Sub'
    );
    expect(normalizeWorkspaceTrustConfigKey('\\\\server\\share\\Repo', { platform: 'win32' })).toBe(
      '//server/share/Repo'
    );
    expect(normalizeWorkspaceTrustComparisonKey('C:\\Repo', { platform: 'win32' })).toBe(
      normalizeWorkspaceTrustComparisonKey('c:/repo/', { platform: 'win32' })
    );
  });

  it('normalizes OneDrive-style Windows paths while preserving config-key casing', () => {
    const workspaces = buildWorkspaceTrustPathCandidates({
      cwd: 'C:\\Users\\vilok\\OneDrive\\Desktop\\Safar 0.1\\',
      realCwd: 'c:\\Users\\vilok\\OneDrive\\Desktop\\Safar 0.1',
      gitRoot: 'C:\\Users\\vilok\\OneDrive\\Desktop\\Safar 0.1',
      homeDir: 'C:\\Users\\vilok',
      platform: 'win32',
    });

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      configKeyCwd: 'C:/Users/vilok/OneDrive/Desktop/Safar 0.1',
      comparisonKey: 'c:/users/vilok/onedrive/desktop/safar 0.1',
      gitRootConfigKey: 'C:/Users/vilok/OneDrive/Desktop/Safar 0.1',
      persistable: true,
    });
  });

  it('collects exact and parent config keys using runtime key normalization', () => {
    expect(collectWorkspaceTrustParentConfigKeys('/tmp/repo/app', { platform: 'posix' })).toEqual([
      '/tmp/repo/app',
      '/tmp/repo',
      '/tmp',
      '/',
    ]);
    expect(collectWorkspaceTrustParentConfigKeys('C:\\Repo\\app', { platform: 'win32' })).toEqual([
      'C:/Repo/app',
      'C:/Repo',
      'C:/',
    ]);
    expect(
      collectWorkspaceTrustParentConfigKeys('\\\\server\\share\\Repo\\App', { platform: 'win32' })
    ).toEqual(['//server/share/Repo/App', '//server/share/Repo', '//server/share/']);
  });

  it('builds cwd, realpath, and git-root candidates without duplicate comparison keys', () => {
    const workspaces = buildWorkspaceTrustPathCandidates({
      cwd: '/var/folders/project',
      realCwd: '/private/var/folders/project',
      gitRoot: '/private/var/folders/project',
      source: 'member-worktree',
      memberId: 'alice-reviewer',
      platform: 'posix',
    });

    expect(workspaces).toHaveLength(2);
    expect(workspaces.map((workspace) => workspace.configKeyCwd)).toEqual([
      '/var/folders/project',
      '/private/var/folders/project',
    ]);
    expect(workspaces[0]).toMatchObject({
      displayCwd: '/var/folders/project',
      source: 'member-worktree',
      memberId: 'alice-reviewer',
      gitRootConfigKey: '/private/var/folders/project',
      persistable: true,
    });
  });

  it('marks home, root, and missing paths as non-persistable', () => {
    expect(
      getWorkspaceTrustNonPersistableReason('/Users/belief', {
        homeDir: '/Users/belief/',
        platform: 'posix',
      })
    ).toBe('home_directory');
    expect(getWorkspaceTrustNonPersistableReason('/', { platform: 'posix' })).toBe(
      'filesystem_root'
    );
    expect(getWorkspaceTrustNonPersistableReason('', { platform: 'posix' })).toBe('unavailable');
  });

  it('marks Windows home, drive root, UNC share root, and missing paths as non-persistable', () => {
    expect(
      getWorkspaceTrustNonPersistableReason('C:\\Users\\vilok\\', {
        homeDir: 'c:/users/vilok',
        platform: 'win32',
      })
    ).toBe('home_directory');
    expect(getWorkspaceTrustNonPersistableReason('C:\\', { platform: 'win32' })).toBe(
      'filesystem_root'
    );
    expect(
      getWorkspaceTrustNonPersistableReason('\\\\server\\share\\', { platform: 'win32' })
    ).toBe('filesystem_root');
    expect(getWorkspaceTrustNonPersistableReason('   ', { platform: 'win32' })).toBe('unavailable');
  });
});
