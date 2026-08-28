import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  getDesktopSqliteLockPlatformPolicy,
  resolveDesktopSqliteLockAuthority,
} from '@main/services/infrastructure/DesktopSqliteLockAuthority';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('DesktopSqliteLockAuthority', () => {
  let temporaryRoot: string;
  let authorityRoot: string;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-sqlite-authority-'));
    authorityRoot = `${temporaryRoot}-authority`;
    process.env.AGENT_TEAMS_SQLITE_LOCK_ROOT_FOR_TESTS = authorityRoot;
  });

  afterEach(() => {
    delete process.env.AGENT_TEAMS_SQLITE_LOCK_ROOT_FOR_TESTS;
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    fs.rmSync(authorityRoot, { recursive: true, force: true });
  });

  it.each([
    ['linux', false],
    ['darwin', false],
    ['win32', true],
  ] as const)(
    'keeps Desktop locking enabled under the %s policy',
    (platform, caseInsensitiveNames) => {
      expect(getDesktopSqliteLockPlatformPolicy(platform)).toEqual({
        caseInsensitiveNames,
        databaseRoot: 'same-user-application-data',
        legacyFence: 'beside-target',
      });
    }
  );

  it('converges symlink aliases on one physical target scope', () => {
    const physicalParent = path.join(temporaryRoot, 'physical');
    const aliasParent = path.join(temporaryRoot, 'alias');
    fs.mkdirSync(physicalParent);
    fs.writeFileSync(path.join(physicalParent, 'state.json'), 'state');
    fs.symlinkSync(physicalParent, aliasParent, 'dir');

    const physical = resolveDesktopSqliteLockAuthority(path.join(physicalParent, 'state.json'));
    const alias = resolveDesktopSqliteLockAuthority(path.join(aliasParent, 'state.json'));

    expect(alias.databasePath).toBe(physical.databasePath);
  });

  it('converges hard-link aliases on the exact physical target identity', () => {
    const firstTarget = path.join(temporaryRoot, 'first.json');
    const hardLinkTarget = path.join(temporaryRoot, 'hard-link.json');
    fs.writeFileSync(firstTarget, 'state');
    fs.linkSync(firstTarget, hardLinkTarget);

    expect(resolveDesktopSqliteLockAuthority(firstTarget).databasePath).toBe(
      resolveDesktopSqliteLockAuthority(hardLinkTarget).databasePath
    );
  });

  it('applies Windows case aliases without folding case-sensitive POSIX scopes', () => {
    const upper = path.join(temporaryRoot, 'State.json');
    const lower = path.join(temporaryRoot, 'state.json');

    expect(resolveDesktopSqliteLockAuthority(upper, 'win32').databasePath).toBe(
      resolveDesktopSqliteLockAuthority(lower, 'win32').databasePath
    );
    expect(resolveDesktopSqliteLockAuthority(upper, 'linux').databasePath).not.toBe(
      resolveDesktopSqliteLockAuthority(lower, 'linux').databasePath
    );
    expect(resolveDesktopSqliteLockAuthority(upper, 'darwin').databasePath).not.toBe(
      resolveDesktopSqliteLockAuthority(lower, 'darwin').databasePath
    );
  });

  it('binds different physical parents and basenames to collision-resistant scopes', () => {
    const otherParent = path.join(temporaryRoot, 'other');
    fs.mkdirSync(otherParent);
    const first = resolveDesktopSqliteLockAuthority(path.join(temporaryRoot, 'state.json'));
    const otherName = resolveDesktopSqliteLockAuthority(path.join(temporaryRoot, 'tasks.json'));
    const otherParentScope = resolveDesktopSqliteLockAuthority(
      path.join(otherParent, 'state.json')
    );

    expect(
      new Set([first.databasePath, otherName.databasePath, otherParentScope.databasePath])
    ).toHaveProperty('size', 3);
    if (process.platform !== 'win32') {
      expect(fs.statSync(authorityRoot).mode & 0o777).toBe(0o700);
    }
  });

  it('fails closed when the retained physical target root is substituted', () => {
    const target = path.join(temporaryRoot, 'state.json');
    const authority = resolveDesktopSqliteLockAuthority(target);
    const displaced = `${temporaryRoot}-displaced`;
    fs.renameSync(temporaryRoot, displaced);
    fs.mkdirSync(temporaryRoot);

    expect(() => authority.assertTargetRoot()).toThrow('Desktop SQLite lock target root changed');

    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    fs.renameSync(displaced, temporaryRoot);
  });

  it('rejects a symlinked application authority root', () => {
    const physicalAuthorityRoot = `${authorityRoot}-physical`;
    fs.mkdirSync(physicalAuthorityRoot);
    fs.symlinkSync(physicalAuthorityRoot, authorityRoot, 'dir');

    expect(() => resolveDesktopSqliteLockAuthority(path.join(temporaryRoot, 'state.json'))).toThrow(
      'Unsafe Desktop SQLite lock root'
    );

    fs.unlinkSync(authorityRoot);
    fs.rmSync(physicalAuthorityRoot, { recursive: true, force: true });
  });
});
