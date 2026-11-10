import { randomUUID } from 'node:crypto';

import { EditorFileWatcher } from '@main/services/editor/EditorFileWatcher';
import { safeSendToRenderer } from '@main/utils/safeWebContentsSend';

import { AGENT_BACKEND_REVIEW_FILE_CHANGE_CHANNEL } from '../../../contracts/reviewWatch';

import type {
  BackendReviewFileChangeEvent,
  BackendReviewUnwatchRequest,
  BackendReviewWatchRequest,
} from '../../../contracts/reviewWatch';
import type { BackendRequestGuard } from '../../application/backendBinding';
import type { BackendOperationsFacade } from './BackendOperationsFacade';
import type { BrowserWindow } from 'electron';

type Watcher = Pick<EditorFileWatcher, 'start' | 'setWatchedFiles' | 'stop'>;
interface Subscription {
  request: BackendReviewUnwatchRequest;
  guard: BackendRequestGuard;
  watchers: Watcher[];
}

export interface CapturedReviewWatchOptions {
  facade: Pick<BackendOperationsFacade, 'invoke'>;
  /** Captured at bridge construction; never resolves a replacement window. */
  window: BrowserWindow | null;
  createWatcher?: () => Watcher;
  send?: (
    window: BrowserWindow | null,
    channel: string,
    event: BackendReviewFileChangeEvent
  ) => boolean;
}

/** Main-only file notification mechanism. Host alone authorizes the captured owner's paths. */
export function createCapturedReviewWatch(options: CapturedReviewWatchOptions) {
  const invoke = options.facade.invoke.bind(options.facade);
  const window = options.window;
  const createWatcher =
    options.createWatcher ?? (() => new EditorFileWatcher({ ignoreStartupChanges: false }));
  const send = options.send ?? safeSendToRenderer;
  const subscriptions = new Map<string, Map<string, Subscription>>();
  let disposed = false;

  function assertCurrent(guard: BackendRequestGuard): void {
    if (disposed || !guard.isCurrent())
      throw new Error('Captured review watch is no longer current');
  }

  function validate(request: BackendReviewUnwatchRequest): void {
    if (
      !request ||
      typeof request !== 'object' ||
      !request.handle ||
      typeof request.handle.handleId !== 'string' ||
      !request.handle.handleId ||
      request.handle.handleId.length > 512 ||
      typeof request.watchId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(request.watchId)
    ) {
      throw new Error('Invalid captured review watch identity');
    }
  }

  function get(request: BackendReviewUnwatchRequest): Subscription | undefined {
    return subscriptions.get(request.handle.handleId)?.get(request.watchId);
  }

  function retire(subscription: Subscription): void {
    const { request } = subscription;
    const owner = subscriptions.get(request.handle.handleId);
    if (owner?.get(request.watchId) === subscription) {
      owner.delete(request.watchId);
      if (owner.size === 0) subscriptions.delete(request.handle.handleId);
    }
    subscription.watchers.splice(0).forEach((watcher) => watcher.stop());
  }

  async function watch(
    request: BackendReviewWatchRequest,
    guard: BackendRequestGuard
  ): Promise<void> {
    validate(request);
    assertCurrent(guard);
    // Snapshot every renderer value before an await; the facade validates the finite query payload.
    const captured = {
      handle: { handleId: request.handle.handleId },
      watchId: request.watchId,
      projectPath: request.projectPath,
      filePaths: Array.isArray(request.filePaths) ? [...request.filePaths] : request.filePaths,
      ...(request.scope === undefined ? {} : { scope: structuredClone(request.scope) }),
    };
    const previous = get(captured);
    if (previous) retire(previous);
    const subscription: Subscription = {
      request: captured,
      guard: Object.freeze({ isCurrent: guard.isCurrent.bind(guard) }),
      watchers: [],
    };
    let owner = subscriptions.get(captured.handle.handleId);
    if (!owner) {
      owner = new Map();
      subscriptions.set(captured.handle.handleId, owner);
    }
    owner.set(captured.watchId, subscription);
    try {
      const result = await invoke(
        {
          handle: captured.handle,
          commandId: randomUUID(),
          operation: 'review.authorizeWatch',
          payload: {
            projectPath: captured.projectPath,
            filePaths: captured.filePaths,
            ...(captured.scope === undefined ? {} : { scope: captured.scope }),
          },
        },
        subscription.guard
      );
      assertCurrent(subscription.guard);
      // Unwatch, replacement and disposal all invalidate this exact pending subscription.
      if (get(captured) !== subscription) return;
      if (
        !result.ok ||
        !result.value ||
        typeof result.value !== 'object' ||
        !('kind' in result.value) ||
        result.value.kind !== 'review-watch-authorization'
      ) {
        throw new Error('Captured review watch authorization unavailable');
      }
      const authorization = structuredClone(result.value);
      const groups = authorization.roots ?? [
        { projectPath: authorization.projectPath, filePaths: authorization.filePaths },
      ];
      const identity = JSON.stringify(authorization);
      const revalidatingPaths = new Set<string>();
      const emit = async (event: { path: string; type: BackendReviewFileChangeEvent['type'] }) => {
        if (get(captured) !== subscription || disposed) return;
        if (revalidatingPaths.has(event.path)) return;
        revalidatingPaths.add(event.path);
        try {
          assertCurrent(subscription.guard);
          // Scoped notifications retain the original Host evidence/root identity throughout
          // the subscription. A new grant/root cannot silently replace an old admission.
          if (captured.scope?.taskId || captured.scope?.memberName) {
            const fresh = await invoke(
              {
                handle: captured.handle,
                commandId: randomUUID(),
                operation: 'review.authorizeWatch',
                payload: {
                  projectPath: captured.projectPath,
                  filePaths: captured.filePaths,
                  scope: captured.scope,
                },
              },
              subscription.guard
            );
            assertCurrent(subscription.guard);
            if (get(captured) !== subscription) return;
            if (!fresh.ok || !fresh.value || JSON.stringify(fresh.value) !== identity)
              throw new Error('Captured review watch authority changed');
          }
          send(window, AGENT_BACKEND_REVIEW_FILE_CHANGE_CHANNEL, {
            handleId: captured.handle.handleId,
            watchId: captured.watchId,
            path: event.path,
            type: event.type,
          });
        } catch {
          retire(subscription);
        } finally {
          revalidatingPaths.delete(event.path);
        }
      };
      for (const group of groups) {
        const allowed = new Set(group.filePaths);
        const watcher = createWatcher();
        subscription.watchers.push(watcher);
        assertCurrent(subscription.guard);
        watcher.start(group.projectPath, (event) => {
          if (allowed.has(event.path)) void emit(event);
        });
        assertCurrent(subscription.guard);
        watcher.setWatchedFiles([...group.filePaths]);
      }
    } catch (error) {
      retire(subscription);
      throw error;
    }
  }

  /** Shell validates the captured window/mainFrame synchronously before this stop-only cleanup. */
  function unwatch(request: BackendReviewUnwatchRequest): void {
    validate(request);
    const subscription = get(request);
    if (subscription) retire(subscription);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const owner of [...subscriptions.values()]) {
      for (const subscription of [...owner.values()]) retire(subscription);
    }
  }

  return { watch, unwatch, dispose };
}

export type CapturedReviewWatch = ReturnType<typeof createCapturedReviewWatch>;
