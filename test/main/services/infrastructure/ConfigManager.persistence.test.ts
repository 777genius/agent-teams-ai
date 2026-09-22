import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  atomicWriteAsync: vi.fn(),
}));

vi.mock('@main/utils/atomicWrite', () => ({
  atomicWriteAsync: mocks.atomicWriteAsync,
}));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { ConfigManager } from '../../../../src/main/services/infrastructure/ConfigManager';
import { TriggerManager } from '../../../../src/main/services/infrastructure/TriggerManager';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let managerNumber = 0;

function createManager(): ConfigManager {
  managerNumber += 1;
  return new ConfigManager(
    path.join(os.tmpdir(), 'config-manager-persistence-tests', `${managerNumber}.json`)
  );
}

describe('ConfigManager durable persistence', () => {
  beforeEach(() => {
    mocks.atomicWriteAsync.mockReset();
    mocks.atomicWriteAsync.mockResolvedValue(undefined);
  });

  it('publishes immutable snapshots through one monotonic writer under completion pressure', async () => {
    const firstWrite = createDeferred();
    const secondWrite = createDeferred();
    mocks.atomicWriteAsync
      .mockReturnValueOnce(firstWrite.promise)
      .mockReturnValueOnce(secondWrite.promise);
    const manager = createManager();

    manager.updateConfig('display', { compactMode: true });
    manager.updateConfig('display', { showTimestamps: false });

    await vi.waitFor(() => expect(mocks.atomicWriteAsync).toHaveBeenCalledTimes(1));
    const firstSnapshot = JSON.parse(mocks.atomicWriteAsync.mock.calls[0][1] as string) as {
      display: { compactMode: boolean; showTimestamps: boolean };
    };
    expect(firstSnapshot.display).toMatchObject({ compactMode: true, showTimestamps: true });

    firstWrite.resolve();
    await vi.waitFor(() => expect(mocks.atomicWriteAsync).toHaveBeenCalledTimes(2));
    const secondSnapshot = JSON.parse(mocks.atomicWriteAsync.mock.calls[1][1] as string) as {
      display: { compactMode: boolean; showTimestamps: boolean };
    };
    expect(secondSnapshot.display).toMatchObject({ compactMode: true, showTimestamps: false });

    secondWrite.resolve();
    await manager.flush();
  });

  it('keeps flush pending until the accepted write reaches a terminal outcome', async () => {
    const write = createDeferred();
    mocks.atomicWriteAsync.mockReturnValueOnce(write.promise);
    const manager = createManager();
    manager.updateConfig('display', { compactMode: true });
    await vi.waitFor(() => expect(mocks.atomicWriteAsync).toHaveBeenCalledTimes(1));

    let flushSettled = false;
    const flushPromise = manager.flush().finally(() => {
      flushSettled = true;
    });
    await Promise.resolve();

    expect(flushSettled).toBe(false);
    write.resolve();
    await expect(flushPromise).resolves.toBeUndefined();
    expect(flushSettled).toBe(true);
  });

  it('exposes a failed revision and rejects flush without leaking the writer rejection', async () => {
    const failure = new Error('config persistence failed');
    mocks.atomicWriteAsync.mockRejectedValueOnce(failure);
    const manager = createManager();

    expect(() => manager.updateConfig('display', { compactMode: true })).not.toThrow();
    await expect(manager.flush()).rejects.toBe(failure);
    expect(manager.getPersistenceFailure()).toEqual({ revision: 1, error: failure });
  });

  it('continues in order after failure and clears failure state only after a later publication', async () => {
    const failure = new Error('first write failed');
    mocks.atomicWriteAsync.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const manager = createManager();

    manager.updateConfig('display', { compactMode: true });
    await expect(manager.flush()).rejects.toBe(failure);

    manager.updateConfig('display', { showTimestamps: false });
    await expect(manager.flush()).resolves.toBeUndefined();

    expect(mocks.atomicWriteAsync).toHaveBeenCalledTimes(2);
    expect(manager.getPersistenceFailure()).toBeNull();
    const recoverySnapshot = JSON.parse(mocks.atomicWriteAsync.mock.calls[1][1] as string) as {
      display: { compactMode: boolean; showTimestamps: boolean };
    };
    expect(recoverySnapshot.display).toMatchObject({ compactMode: true, showTimestamps: false });
  });

  it('coalesces concurrent flush retries of one failed dirty snapshot', async () => {
    const failure = new Error('first write failed');
    const retryWrite = createDeferred();
    mocks.atomicWriteAsync.mockRejectedValueOnce(failure).mockReturnValueOnce(retryWrite.promise);
    const manager = createManager();

    manager.updateConfig('display', { compactMode: true });
    await expect(manager.flush()).rejects.toBe(failure);

    const firstRetry = manager.flush();
    const secondRetry = manager.flush();
    await vi.waitFor(() => expect(mocks.atomicWriteAsync).toHaveBeenCalledTimes(2));
    retryWrite.resolve();

    await expect(Promise.all([firstRetry, secondRetry])).resolves.toEqual([undefined, undefined]);
    expect(mocks.atomicWriteAsync).toHaveBeenCalledTimes(2);
    expect(manager.getPersistenceFailure()).toBeNull();
  });

  it('publishes assigned trigger state before a successful trigger write clears failure', async () => {
    const failure = new Error('first write failed');
    mocks.atomicWriteAsync.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const manager = createManager();

    manager.updateConfig('display', { compactMode: true });
    await expect(manager.flush()).rejects.toBe(failure);

    manager.addTrigger({
      id: 'custom-recovery-trigger',
      name: 'Recovery trigger',
      enabled: true,
      contentType: 'tool_result',
      mode: 'error_status',
      requireError: true,
      isBuiltin: false,
    });
    await expect(manager.flush()).resolves.toBeUndefined();

    expect(manager.getPersistenceFailure()).toBeNull();
    expect(mocks.atomicWriteAsync).toHaveBeenCalledTimes(2);
    const recoverySnapshot = JSON.parse(mocks.atomicWriteAsync.mock.calls[1][1] as string) as {
      notifications: { triggers: Array<{ id: string; name: string }> };
    };
    expect(recoverySnapshot.notifications.triggers).toContainEqual(
      expect.objectContaining({
        id: 'custom-recovery-trigger',
        name: 'Recovery trigger',
      })
    );
  });

  it('uses strict file durability and parent-directory synchronization for every write', async () => {
    const manager = createManager();
    manager.updateConfig('display', { compactMode: true });

    await manager.flush();

    expect(mocks.atomicWriteAsync).toHaveBeenCalledWith(
      manager.getConfigPath(),
      expect.any(String),
      {
        durability: 'strict',
        syncDirectory: true,
        onDirectorySyncOutcome: expect.any(Function),
      }
    );
  });
});

describe('TriggerManager persistence boundary', () => {
  it('returns cloned trigger state without retaining caller-owned trigger objects', () => {
    const trigger = {
      id: 'custom-clone-trigger',
      name: 'Original trigger',
      enabled: true,
      contentType: 'tool_result' as const,
      mode: 'error_status' as const,
      requireError: true,
      isBuiltin: false,
    };
    const manager = new TriggerManager([]);

    const returnedState = manager.add(trigger);
    returnedState[0].name = 'Changed returned state';
    trigger.name = 'Changed caller state';

    expect(manager.getById('custom-clone-trigger')?.name).toBe('Original trigger');
  });
});

describe('ConfigManager atomic-write adapter recovery', () => {
  it('retries the latest dirty snapshot after a real filesystem write fault is removed', async () => {
    vi.resetModules();
    vi.doUnmock('@main/utils/atomicWrite');
    const { ConfigManager: AdapterConfigManager } =
      await import('../../../../src/main/services/infrastructure/ConfigManager');
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-manager-adapter-retry-'));
    const blockedParent = path.join(sandboxRoot, 'blocked-parent');
    const configPath = path.join(blockedParent, 'config.json');

    try {
      // A regular file where the config directory must be is deterministic even for privileged users.
      fs.writeFileSync(blockedParent, 'injected parent-directory fault', 'utf8');
      const manager = new AdapterConfigManager(configPath);
      manager.updateConfig('display', { compactMode: true });
      manager.updateConfig('display', { showTimestamps: false });

      await expect(manager.flush()).rejects.toBeDefined();
      expect(fs.existsSync(configPath)).toBe(false);
      expect(manager.getPersistenceFailure()?.revision).toBe(2);

      fs.unlinkSync(blockedParent);
      fs.mkdirSync(blockedParent);

      await expect(manager.flush()).resolves.toBeUndefined();

      expect(fs.existsSync(configPath)).toBe(true);
      expect(manager.getPersistenceFailure()).toBeNull();
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        display: { compactMode: boolean; showTimestamps: boolean };
      };
      expect(persisted.display).toMatchObject({ compactMode: true, showTimestamps: false });
    } finally {
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });
});
