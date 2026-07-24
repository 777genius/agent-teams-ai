import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type NodeExternalWriterNativeWatcher,
  type NodeExternalWriterWatchFactory,
  NodeExternalWriterWatchPort,
  NodeExternalWriterWatchPortError,
  RegisteredExternalFileCatalog,
  RegisteredExternalFileCatalogError,
} from '@features/external-writer-coordination/main';
import { parseTeamId } from '@shared/contracts/hosted/identifiers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ExternalWriterNotification,
  ExternalWriterOverflowNotification,
} from '@features/external-writer-coordination';

const teamId = parseTeamId('team_11111111111111111111111111111111');
const otherTeamId = parseTeamId('team_22222222222222222222222222222222');

class FakeNativeWatcher implements NodeExternalWriterNativeWatcher {
  private errorListener: ((error: Error) => void) | null = null;
  readonly close = vi.fn();

  on(event: 'error', listener: (error: Error) => void): NodeExternalWriterNativeWatcher {
    if (event === 'error') {
      this.errorListener = listener;
    }
    return this;
  }

  emitError(): void {
    this.errorListener?.(new Error('fixture watcher failure'));
  }
}

describe('NodeExternalWriterWatchPort', () => {
  let fixtureRoot: string;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'node-external-writer-watch-'));
  });

  afterEach(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  it('has the native watch installed before start resolves and emits only registered keys', async () => {
    const registeredPath = join(fixtureRoot, 'registered.json');
    const replacementPath = join(fixtureRoot, 'replacement.json');
    const unregisteredPath = join(fixtureRoot, 'unregistered.json');
    await Promise.all([
      writeFile(registeredPath, 'before'),
      writeFile(unregisteredPath, 'unregistered-before'),
    ]);
    const catalog = new RegisteredExternalFileCatalog([
      {
        rootPath: fixtureRoot,
        filePath: registeredPath,
        registration: {
          scope: { teamId, featureKey: 'tasks' },
          fileKey: 'registered',
          maxBytes: 1_024,
          attributionPolicy: 'external_file_only',
        },
      },
    ]);
    const port = new NodeExternalWriterWatchPort(catalog);
    const notifications: Array<{
      kind: string;
      fileKey: string;
    }> = [];
    let resolveRegistered!: () => void;
    const registeredEvent = new Promise<void>((resolve) => {
      resolveRegistered = resolve;
    });
    const handle = await port.start({
      onNotification(notification) {
        notifications.push({
          kind: notification.kind,
          fileKey: notification.fileKey,
        });
        resolveRegistered();
      },
      onOverflow: vi.fn(),
    });

    await writeFile(unregisteredPath, 'unregistered-after');
    await writeFile(replacementPath, 'after');
    await rename(replacementPath, registeredPath);
    await Promise.race([
      registeredEvent,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('registered watch event timed out')), 2_000);
      }),
    ]);

    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.every((notification) => notification.fileKey === 'registered')).toBe(true);
    expect(notifications.some((notification) => notification.kind === 'rename')).toBe(true);
    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('distinguishes recoverable overflow from terminal native-watch invalidation by scope', async () => {
    const firstParent = join(fixtureRoot, 'first');
    const secondParent = join(fixtureRoot, 'second');
    await Promise.all([mkdir(firstParent), mkdir(secondParent)]);
    const firstPath = join(firstParent, 'first.json');
    const secondPath = join(secondParent, 'second.json');
    await Promise.all([writeFile(firstPath, '{}'), writeFile(secondPath, '{}')]);
    const firstScope = { teamId, featureKey: 'tasks' } as const;
    const secondScope = {
      teamId: otherTeamId,
      featureKey: 'messages',
    } as const;
    const catalog = new RegisteredExternalFileCatalog([
      {
        rootPath: fixtureRoot,
        filePath: firstPath,
        registration: {
          scope: firstScope,
          fileKey: 'first',
          maxBytes: 1_024,
          attributionPolicy: 'external_file_only',
        },
      },
      {
        rootPath: fixtureRoot,
        filePath: secondPath,
        registration: {
          scope: secondScope,
          fileKey: 'second',
          maxBytes: 1_024,
          attributionPolicy: 'external_file_only',
        },
      },
    ]);
    const nativeWatches: Array<{
      parentPath: string;
      onEvent: Parameters<NodeExternalWriterWatchFactory>[0]['onEvent'];
      watcher: FakeNativeWatcher;
    }> = [];
    const watchFactory: NodeExternalWriterWatchFactory = (input) => {
      const watcher = new FakeNativeWatcher();
      nativeWatches.push({
        parentPath: input.parentPath,
        onEvent: input.onEvent,
        watcher,
      });
      return watcher;
    };
    const notifications = vi.fn<(notification: ExternalWriterNotification) => void>();
    const overflows = vi.fn<(notification: ExternalWriterOverflowNotification) => void>();
    const invalidations = vi.fn();
    const port = new NodeExternalWriterWatchPort(catalog, {
      onInvalidation: invalidations,
      watchFactory,
    });
    const handle = await port.start({
      onNotification: notifications,
      onOverflow: overflows,
    });

    expect(nativeWatches).toHaveLength(2);
    const firstWatch = nativeWatches.find((entry) => entry.parentPath === firstParent)!;
    const secondWatch = nativeWatches.find((entry) => entry.parentPath === secondParent)!;
    firstWatch.onEvent('change', 'unregistered.json');
    expect(notifications).not.toHaveBeenCalled();
    expect(overflows).not.toHaveBeenCalled();

    firstWatch.onEvent('native-overflow', 'first.json');
    firstWatch.onEvent('rename', null);
    expect(invalidations).not.toHaveBeenCalled();
    expect(handle.getInvalidations()).toEqual([]);

    secondWatch.watcher.emitError();
    expect(overflows.mock.calls).toEqual([
      [{ scopes: [firstScope] }],
      [{ scopes: [firstScope] }],
      [{ scopes: [secondScope] }],
    ]);
    expect(
      overflows.mock.calls.some(([notification]) =>
        notification.scopes.some(
          (scope) =>
            scope.teamId === secondScope.teamId && scope.featureKey === secondScope.featureKey
        )
      )
    ).toBe(true);
    expect(
      overflows.mock.calls.some(
        ([notification]) =>
          notification.scopes.some(
            (scope) =>
              scope.teamId === firstScope.teamId && scope.featureKey === firstScope.featureKey
          ) &&
          notification.scopes.some(
            (scope) =>
              scope.teamId === secondScope.teamId && scope.featureKey === secondScope.featureKey
          )
      )
    ).toBe(false);
    expect(invalidations).toHaveBeenCalledTimes(1);
    expect(invalidations).toHaveBeenCalledWith({
      kind: 'terminal_invalidation',
      reason: 'native_watch_error',
      reestablishment: 'construct_and_start_fresh_catalog_and_port',
      scopes: [secondScope],
    });
    expect(handle.getInvalidations()).toEqual([
      {
        kind: 'terminal_invalidation',
        reason: 'native_watch_error',
        reestablishment: 'construct_and_start_fresh_catalog_and_port',
        scopes: [secondScope],
      },
    ]);
    expect(port.getInvalidations()).toEqual(handle.getInvalidations());
    await expect(catalog.listRegistrations(secondScope)).rejects.toThrowError(
      new RegisteredExternalFileCatalogError('watch_invalidated')
    );
    await expect(catalog.listRegistrations(firstScope)).resolves.toHaveLength(1);

    await handle.close();
    await handle.close();
    expect(firstWatch.watcher.close).toHaveBeenCalledTimes(1);
    expect(secondWatch.watcher.close).toHaveBeenCalledTimes(1);
    firstWatch.onEvent('change', 'first.json');
    expect(notifications).not.toHaveBeenCalled();
    await expect(port.start({ onNotification: vi.fn(), onOverflow: vi.fn() })).rejects.toThrowError(
      new NodeExternalWriterWatchPortError('already_started')
    );
  });

  it('invalidates only the affected watcher when its retained parent identity is replaced', async () => {
    vi.useFakeTimers();
    try {
      const firstParent = join(fixtureRoot, 'first');
      const detachedFirstParent = join(fixtureRoot, 'first-detached');
      const secondParent = join(fixtureRoot, 'second');
      await Promise.all([mkdir(firstParent), mkdir(secondParent)]);
      const firstPath = join(firstParent, 'first.json');
      const secondPath = join(secondParent, 'second.json');
      await Promise.all([writeFile(firstPath, '{}'), writeFile(secondPath, '{}')]);
      const firstScope = { teamId, featureKey: 'tasks' } as const;
      const secondScope = { teamId: otherTeamId, featureKey: 'messages' } as const;
      const catalog = new RegisteredExternalFileCatalog([
        {
          rootPath: fixtureRoot,
          filePath: firstPath,
          registration: {
            scope: firstScope,
            fileKey: 'first',
            maxBytes: 1_024,
            attributionPolicy: 'external_file_only',
          },
        },
        {
          rootPath: fixtureRoot,
          filePath: secondPath,
          registration: {
            scope: secondScope,
            fileKey: 'second',
            maxBytes: 1_024,
            attributionPolicy: 'external_file_only',
          },
        },
      ]);
      const nativeWatches: Array<{
        parentPath: string;
        onEvent: Parameters<NodeExternalWriterWatchFactory>[0]['onEvent'];
        watcher: FakeNativeWatcher;
      }> = [];
      const watchFactory: NodeExternalWriterWatchFactory = (input) => {
        const watcher = new FakeNativeWatcher();
        nativeWatches.push({ parentPath: input.parentPath, onEvent: input.onEvent, watcher });
        return watcher;
      };
      const notifications = vi.fn<(notification: ExternalWriterNotification) => void>();
      const overflows = vi.fn<(notification: ExternalWriterOverflowNotification) => void>();
      const invalidations = vi.fn();
      const port = new NodeExternalWriterWatchPort(catalog, {
        onInvalidation: invalidations,
        watchFactory,
      });
      const handle = await port.start({ onNotification: notifications, onOverflow: overflows });
      const firstWatch = nativeWatches.find((entry) => entry.parentPath === firstParent)!;
      const secondWatch = nativeWatches.find((entry) => entry.parentPath === secondParent)!;

      await rename(firstParent, detachedFirstParent);
      await mkdir(firstParent);
      await writeFile(firstPath, '{"replacement":true}');
      await vi.advanceTimersByTimeAsync(1_000);

      // The replaced watch reports terminal invalidation; the unaffected
      // watch independently requests its bounded attachment-safety rescan.
      expect(overflows.mock.calls).toEqual([
        [{ scopes: [firstScope] }],
        [{ scopes: [secondScope] }],
      ]);
      expect(invalidations).toHaveBeenCalledTimes(1);
      expect(invalidations).toHaveBeenCalledWith({
        kind: 'terminal_invalidation',
        reason: 'watched_identity_replaced',
        reestablishment: 'construct_and_start_fresh_catalog_and_port',
        scopes: [firstScope],
      });
      expect(handle.getInvalidations()).toEqual([
        {
          kind: 'terminal_invalidation',
          reason: 'watched_identity_replaced',
          reestablishment: 'construct_and_start_fresh_catalog_and_port',
          scopes: [firstScope],
        },
      ]);
      await expect(catalog.listRegistrations(firstScope)).rejects.toThrowError(
        new RegisteredExternalFileCatalogError('watch_invalidated')
      );
      await expect(catalog.listRegistrations(secondScope)).resolves.toHaveLength(1);
      expect(firstWatch.watcher.close).toHaveBeenCalledTimes(1);
      expect(secondWatch.watcher.close).not.toHaveBeenCalled();

      firstWatch.onEvent('change', 'first.json');
      secondWatch.onEvent('change', 'second.json');
      expect(notifications.mock.calls).toEqual([
        [{ kind: 'change', scope: secondScope, fileKey: 'second' }],
      ]);

      await handle.close();
      await handle.close();
      expect(firstWatch.watcher.close).toHaveBeenCalledTimes(1);
      expect(secondWatch.watcher.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminally invalidates an active watcher when its registered root identity is replaced', async () => {
    const registeredRoot = join(fixtureRoot, 'registered-root');
    const detachedRoot = join(fixtureRoot, 'registered-root-detached');
    await mkdir(registeredRoot);
    const filePath = join(registeredRoot, 'task.json');
    await writeFile(filePath, '{}');
    const scope = { teamId, featureKey: 'tasks' } as const;
    const catalog = new RegisteredExternalFileCatalog([
      {
        rootPath: registeredRoot,
        filePath,
        registration: {
          scope,
          fileKey: 'task-1',
          maxBytes: 1_024,
          attributionPolicy: 'external_file_only',
        },
      },
    ]);
    let nativeWatchInput!: Parameters<NodeExternalWriterWatchFactory>[0];
    const nativeWatcher = new FakeNativeWatcher();
    const invalidations = vi.fn();
    const port = new NodeExternalWriterWatchPort(catalog, {
      onInvalidation: invalidations,
      watchFactory(input) {
        nativeWatchInput = input;
        return nativeWatcher;
      },
    });
    const overflows = vi.fn<(notification: ExternalWriterOverflowNotification) => void>();
    const handle = await port.start({ onNotification: vi.fn(), onOverflow: overflows });

    await rename(registeredRoot, detachedRoot);
    await mkdir(registeredRoot);
    await writeFile(filePath, '{"replacement":true}');
    nativeWatchInput.onEvent('rename', 'task.json');

    expect(invalidations).toHaveBeenCalledWith({
      kind: 'terminal_invalidation',
      reason: 'watched_identity_replaced',
      reestablishment: 'construct_and_start_fresh_catalog_and_port',
      scopes: [scope],
    });
    expect(overflows).toHaveBeenCalledWith({ scopes: [scope] });
    expect(nativeWatcher.close).toHaveBeenCalledTimes(1);
    await expect(catalog.listRegistrations(scope)).rejects.toThrowError(
      new RegisteredExternalFileCatalogError('watch_invalidated')
    );
    const replacementPort = new NodeExternalWriterWatchPort(catalog, {
      watchFactory: vi.fn(),
    });
    await expect(
      replacementPort.start({ onNotification: vi.fn(), onOverflow: vi.fn() })
    ).rejects.toThrowError(new NodeExternalWriterWatchPortError('start_failed'));

    await handle.close();
    await handle.close();
  });

  it('refuses to watch when the registered root changed after catalog construction', async () => {
    const registeredRoot = join(fixtureRoot, 'registered-root');
    const originalRoot = join(fixtureRoot, 'original-root');
    await mkdir(registeredRoot);
    const filePath = join(registeredRoot, 'task.json');
    await writeFile(filePath, '{}');
    const catalog = new RegisteredExternalFileCatalog([
      {
        rootPath: registeredRoot,
        filePath,
        registration: {
          scope: { teamId, featureKey: 'tasks' },
          fileKey: 'task-1',
          maxBytes: 1_024,
          attributionPolicy: 'external_file_only',
        },
      },
    ]);
    await rename(registeredRoot, originalRoot);
    await mkdir(registeredRoot);
    await writeFile(filePath, '{"replacement":true}');
    const watchFactory = vi.fn<NodeExternalWriterWatchFactory>();
    const port = new NodeExternalWriterWatchPort(catalog, { watchFactory });

    await expect(port.start({ onNotification: vi.fn(), onOverflow: vi.fn() })).rejects.toThrowError(
      new NodeExternalWriterWatchPortError('start_failed')
    );
    expect(watchFactory).not.toHaveBeenCalled();
  });
});
