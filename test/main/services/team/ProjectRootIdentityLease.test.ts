import {
  captureProjectRootIdentityLease,
  resolveConservativeProjectRootAuthorityKey,
  resolveProjectRootAuthorityKey,
} from '@main/services/team/ProjectRootIdentityLease';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import type { ProjectRootIdentityLeaseFileSystem } from '@main/services/team/ProjectRootIdentityLease';

function directoryStats(dev: bigint, ino: bigint) {
  return { dev, ino, isDirectory: () => true };
}

describe('ProjectRootIdentityLease cross-platform directory descriptor contract', () => {
  it('case-normalizes Windows comparison keys without changing paths passed to fs APIs', () => {
    const realpath = vi.fn(() => 'C:\\RealRoot\\Project');
    const stat = vi.fn(() => directoryStats(7n, 42n));
    const openDirectory = vi.fn(() => 19);
    const fstat = vi.fn(() => directoryStats(7n, 42n));
    const close = vi.fn();
    const fileSystem: ProjectRootIdentityLeaseFileSystem = {
      realpath,
      stat,
      openDirectory,
      fstat,
      close,
    };
    const lease = captureProjectRootIdentityLease('C:\\WorkRoot\\Project', {
      platform: 'win32',
      fileSystem,
    });

    expect(realpath).toHaveBeenCalledWith('C:\\WorkRoot\\Project');
    expect(stat).toHaveBeenCalledWith('C:\\RealRoot\\Project');
    expect(openDirectory).toHaveBeenCalledWith('C:\\RealRoot\\Project');
    expect(lease.identity).toEqual({
      requestedPath: 'c:\\workroot\\project',
      canonicalPath: 'c:\\realroot\\project',
      stableFileId: 'device:7:inode:42',
    });
    expect(lease.isCurrent('c:\\WORKROOT\\PROJECT')).toBe(true);
    lease.close();
    lease.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(19);
  });

  it.each([
    { dev: 0n, ino: 42n },
    { dev: 7n, ino: 0n },
    { dev: 0n, ino: 0n },
  ])(
    'fails closed when dev/ino cannot prove a nonzero object identity ($dev/$ino)',
    ({ dev, ino }) => {
      const fileSystem: ProjectRootIdentityLeaseFileSystem = {
        realpath: () => 'C:\\Real\\Project',
        stat: () => directoryStats(dev, ino),
        openDirectory: vi.fn(() => 20),
        fstat: () => directoryStats(dev, ino),
        close: vi.fn(),
      };

      expect(() =>
        captureProjectRootIdentityLease('C:\\Work\\Project', {
          platform: 'win32',
          fileSystem,
        })
      ).toThrow('stable project filesystem identity');
      expect(fileSystem.openDirectory).not.toHaveBeenCalled();
    }
  );

  it('case-folds Windows physical and missing-path authority keys conservatively', () => {
    const physicalFileSystem: ProjectRootIdentityLeaseFileSystem = {
      realpath: () => 'C:\\RealRoot\\Project',
      stat: () => directoryStats(7n, 42n),
      openDirectory: vi.fn(() => 20),
      fstat: () => directoryStats(7n, 42n),
      close: vi.fn(),
    };
    expect(
      resolveProjectRootAuthorityKey('C:\\WorkRoot\\Project', {
        platform: 'win32',
        fileSystem: physicalFileSystem,
      })
    ).toBe(
      resolveProjectRootAuthorityKey('c:\\workroot\\project', {
        platform: 'win32',
        fileSystem: physicalFileSystem,
      })
    );

    const missingFileSystem: ProjectRootIdentityLeaseFileSystem = {
      ...physicalFileSystem,
      realpath: () => {
        throw new Error('missing or remote');
      },
    };
    expect(
      resolveConservativeProjectRootAuthorityKey('C:\\Missing\\Project', {
        platform: 'win32',
        fileSystem: missingFileSystem,
      })
    ).toBe(
      resolveConservativeProjectRootAuthorityKey('c:\\missing\\project', {
        platform: 'win32',
        fileSystem: missingFileSystem,
      })
    );
    expect(
      resolveConservativeProjectRootAuthorityKey('C:\\Missing\\Other', {
        platform: 'win32',
        fileSystem: missingFileSystem,
      })
    ).not.toBe(
      resolveConservativeProjectRootAuthorityKey('C:\\Missing\\Project', {
        platform: 'win32',
        fileSystem: missingFileSystem,
      })
    );
  });

  it.skipIf(process.platform === 'win32')(
    'unifies symlink aliases while keeping lexical lease validation exact',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-authority-alias-'));
      try {
        const project = path.join(root, 'physical');
        const aliasA = path.join(root, 'alias-a');
        const aliasB = path.join(root, 'alias-b');
        const unrelated = path.join(root, 'unrelated');
        fs.mkdirSync(project);
        fs.mkdirSync(unrelated);
        fs.symlinkSync(project, aliasA, 'dir');
        fs.symlinkSync(project, aliasB, 'dir');

        const lease = captureProjectRootIdentityLease(aliasB);
        expect(resolveProjectRootAuthorityKey(aliasA)).toBe(lease.authorityKey);
        expect(resolveProjectRootAuthorityKey(aliasB)).toBe(lease.authorityKey);
        expect(resolveProjectRootAuthorityKey(unrelated)).not.toBe(lease.authorityKey);
        expect(lease.matchesCurrentAuthority(resolveProjectRootAuthorityKey(aliasA))).toBe(true);
        expect(lease.isCurrent(aliasA)).toBe(false);
        expect(lease.isCurrent(aliasB)).toBe(true);
        lease.close();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'changes authority keys when a root is replaced at the same lexical path',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-authority-replacement-'));
      const project = path.join(root, 'project');
      const displaced = path.join(root, 'displaced');
      try {
        fs.mkdirSync(project);
        const before = resolveProjectRootAuthorityKey(project);
        fs.renameSync(project, displaced);
        fs.mkdirSync(project);
        expect(resolveProjectRootAuthorityKey(project)).not.toBe(before);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform !== 'win32')(
    'uses Node/libuv directory sharing and distinguishes a renamed root from its replacement',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-directory-fd-contract-'));
      const project = path.join(root, 'project');
      const displaced = path.join(root, 'project-displaced');
      fs.mkdirSync(project);
      const handle = fs.openSync(project, fs.constants.O_RDONLY);
      try {
        const heldBefore = fs.fstatSync(handle, { bigint: true });
        fs.renameSync(project, displaced);
        fs.mkdirSync(project);
        const heldAfter = fs.fstatSync(handle, { bigint: true });
        const replacement = fs.statSync(project, { bigint: true });

        expect([heldBefore.dev, heldBefore.ino]).toEqual([heldAfter.dev, heldAfter.ino]);
        expect([replacement.dev, replacement.ino]).not.toEqual([heldAfter.dev, heldAfter.ino]);
      } finally {
        fs.closeSync(handle);
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
