import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  mkdir: vi.fn(),
  validate: vi.fn(),
  root: vi.fn(),
  syncDirectory: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ open: mocks.open, mkdir: mocks.mkdir }));
vi.mock(
  '../../../src/features/local-http-auth/main/infrastructure/privateFiles',
  () => ({
    validatePrivatePath: mocks.validate,
    validateOwnedDirectoryRoot: mocks.root,
  }),
);
vi.mock('../../../src/main/utils/durableFileSync', () => ({
  syncDirectoryDurably: mocks.syncDirectory,
}));
import { withPublicationLock } from '../../../src/features/local-http-auth/main/infrastructure/publicationLock';

describe('coordination-only helper lock', () => {
  it('closes bootstrap before connecting and holds transaction across all work without schema writes', async () => {
    const order: string[] = [];
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.syncDirectory.mockImplementation(async () => undefined);
    mocks.root.mockResolvedValue('/private/auth');
    mocks.validate.mockResolvedValue({ dev: 1, ino: 2 });
    mocks.open.mockResolvedValue({
      sync: async () => {
        order.push('raw-sync');
      },
      close: async () => {
        order.push('raw-close');
      },
    });
    class Database {
      constructor() {
        order.push('connect');
      }
      exec(sql: string) {
        order.push(sql);
      }
      close() {
        order.push('db-close');
      }
    }
    await expect(
      withPublicationLock('/private/auth', Database, async () => {
        order.push('mutation');
        return 7;
      }),
    ).resolves.toBe(7);
    expect(order).toEqual([
      'raw-sync',
      'raw-close',
      'connect',
      'BEGIN IMMEDIATE',
      'mutation',
      'ROLLBACK',
      'db-close',
    ]);
  });
  it('refuses to connect after an unexpected directory flush failure and never opens the DB for that flush', async () => {
    mocks.open.mockResolvedValue(null);
    const failure = Object.assign(new Error('close failed'), { code: 'EIO' });
    mocks.syncDirectory.mockRejectedValueOnce(failure);
    const connect = vi.fn();
    class Database {
      constructor() {
        connect();
      }
      exec() {}
      close() {}
    }
    await expect(
      withPublicationLock('/private/auth', Database, async () => undefined),
    ).rejects.toBe(failure);
    expect(connect).not.toHaveBeenCalled();
    expect(mocks.syncDirectory).toHaveBeenLastCalledWith(
      '/private/auth/publication.lock',
    );
    mocks.syncDirectory.mockResolvedValue(undefined);
  });
  it('preserves a legacy regular marker and never opens its database', async () => {
    mocks.open.mockClear();
    mocks.validate.mockRejectedValueOnce(new Error('not a private directory'));
    class Database {
      exec() {}
      close() {}
    }
    await expect(
      withPublicationLock('/private/auth', Database, async () => undefined),
    ).rejects.toThrow();
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it('rejects a database inode replaced between validation and acquisition', async () => {
    mocks.open.mockResolvedValue(null);
    mocks.validate
      .mockReset()
      .mockResolvedValueOnce({ dev: 1, ino: 1 })
      .mockResolvedValueOnce({ dev: 1, ino: 2 })
      .mockResolvedValueOnce({ dev: 1, ino: 3 })
      .mockResolvedValueOnce({ dev: 1, ino: 1 });
    const operation = vi.fn();
    const close = vi.fn();
    class Database {
      exec() {}
      close = close;
    }
    await expect(
      withPublicationLock('/private/auth', Database, operation),
    ).rejects.toThrow('coordination changed');
    expect(operation).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it('does not mutate under a busy lock and closes connection even if rollback fails', async () => {
    mocks.open.mockResolvedValue(null);
    mocks.validate.mockResolvedValue({ dev: 1, ino: 2 });
    const operation = vi.fn();
    const close = vi.fn();
    class Busy {
      exec() {
        throw new Error('busy');
      }
      close = close;
    }
    await expect(
      withPublicationLock('/private/auth', Busy, operation),
    ).rejects.toThrow('busy');
    expect(operation).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    class RollbackFailure {
      exec(sql: string) {
        if (sql === 'ROLLBACK') throw new Error('rollback');
      }
      close = close;
    }
    await expect(
      withPublicationLock('/private/auth', RollbackFailure, async () => 1),
    ).rejects.toThrow('rollback');
    expect(close).toHaveBeenCalledTimes(2);
  });
});
