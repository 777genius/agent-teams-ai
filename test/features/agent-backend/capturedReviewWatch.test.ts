// @vitest-environment node
import { parseReviewQuery } from '@agent-teams/task-change-ledger/review-transport';
import { describe, expect, it, vi } from 'vitest';

import { createCapturedReviewWatch } from '../../../src/features/agent-backend/main/adapters/input/CapturedReviewWatch';
import { readCapturedReviewWatchRequest } from '../../../src/features/agent-backend/main/adapters/input/registerCapturedReviewWatchIpc';

import type { BackendOperationResult } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendReviewFileChangeEvent } from '../../../src/features/agent-backend/contracts/reviewWatch';
import type { EditorFileChangeEvent } from '../../../src/shared/types/editor';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  let current = true;
  const guard = { isCurrent: () => current };
  const requests: unknown[] = [];
  const pending: ReturnType<typeof deferred<BackendOperationResult>>[] = [];
  const watchers: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    setWatchedFiles: ReturnType<typeof vi.fn>;
    emit(event: EditorFileChangeEvent): void;
  }[] = [];
  const events: BackendReviewFileChangeEvent[] = [];
  const bridge = createCapturedReviewWatch({
    window: null,
    facade: {
      invoke: vi.fn((request) => {
        requests.push(request);
        const response = deferred<BackendOperationResult>();
        pending.push(response);
        return response.promise;
      }),
    },
    createWatcher() {
      let callback: ((event: EditorFileChangeEvent) => void) | undefined;
      const watcher = {
        start: vi.fn((_root: string, onChange: (event: EditorFileChangeEvent) => void) => {
          callback = onChange;
        }),
        stop: vi.fn(),
        setWatchedFiles: vi.fn(),
        emit(event: EditorFileChangeEvent) {
          callback?.(event);
        },
      };
      watchers.push(watcher);
      return watcher;
    },
    send(_window, _channel, event) {
      events.push(event);
      return true;
    },
  });
  const request = (watchId = 'TEST-watch', handleId = 'TEST-owner-a') => ({
    handle: { handleId },
    watchId,
    projectPath: '/TEST-project',
    filePaths: ['/TEST-project/one.txt'],
  });
  const authorize = (index = 0, filePaths = ['/TEST-project/one.txt']) =>
    pending[index].resolve({
      ok: true,
      value: { kind: 'review-watch-authorization', projectPath: '/TEST-project', filePaths },
    });
  return {
    bridge,
    guard,
    requests,
    watchers,
    events,
    request,
    authorize,
    respond(index: number, result: BackendOperationResult) { pending[index].resolve(result); },
    revoke() {
      current = false;
    },
  };
}

describe('captured review watch', () => {
  it('arms only after Host authorization and emits exact owner-qualified authorized paths', async () => {
    const f = fixture();
    const pending = f.bridge.watch(f.request(), f.guard);
    expect(f.watchers).toHaveLength(0);
    expect(f.requests[0]).toMatchObject({
      handle: { handleId: 'TEST-owner-a' },
      operation: 'review.authorizeWatch',
      payload: { projectPath: '/TEST-project', filePaths: ['/TEST-project/one.txt'] },
    });
    f.authorize();
    await pending;
    expect(f.watchers[0].start).toHaveBeenCalledWith('/TEST-project', expect.any(Function));
    f.watchers[0].emit({ type: 'change', path: '/TEST-project/unrequested.txt' });
    f.watchers[0].emit({ type: 'change', path: '/TEST-project/one.txt' });
    expect(f.events).toEqual([
      {
        handleId: 'TEST-owner-a',
        watchId: 'TEST-watch',
        type: 'change',
        path: '/TEST-project/one.txt',
      },
    ]);
    f.bridge.dispose();
  });

  it('owner revocation while authorization is pending prevents every watcher effect', async () => {
    const f = fixture();
    const pending = f.bridge.watch(f.request(), f.guard);
    f.revoke();
    f.authorize();
    await expect(pending).rejects.toThrow('no longer current');
    expect(f.watchers).toHaveLength(0);
    expect(f.events).toEqual([]);
    f.bridge.dispose();
  });

  it('revoked callbacks retire their original watcher without notifying a replacement owner', async () => {
    const f = fixture();
    const pending = f.bridge.watch(f.request(), f.guard);
    f.authorize();
    await pending;
    f.revoke();
    f.watchers[0].emit({ type: 'delete', path: '/TEST-project/one.txt' });
    expect(f.events).toEqual([]);
    expect(f.watchers[0].stop).toHaveBeenCalledTimes(1);
    f.bridge.dispose();
    expect(f.watchers[0].stop).toHaveBeenCalledTimes(1);
  });

  it('unwatch invalidates an in-flight authorization and cannot stop another captured handle', async () => {
    const f = fixture();
    const a = f.bridge.watch(f.request(), f.guard);
    f.bridge.unwatch(f.request('TEST-watch', 'TEST-owner-b'));
    f.authorize();
    await a;
    expect(f.watchers[0].stop).not.toHaveBeenCalled();
    const b = f.bridge.watch(f.request('TEST-pending'), f.guard);
    f.bridge.unwatch(f.request('TEST-pending'));
    f.authorize(1);
    await b;
    expect(f.watchers).toHaveLength(1);
    f.bridge.dispose();
  });

  it('a slower replaced request never rearms or delivers after the replacement paths win', async () => {
    const f = fixture();
    const first = f.bridge.watch(f.request(), f.guard);
    const second = f.bridge.watch(
      { ...f.request(), filePaths: ['/TEST-project/two.txt'] },
      f.guard
    );
    f.authorize(1, ['/TEST-project/two.txt']);
    await second;
    f.authorize(0);
    await first;
    expect(f.watchers).toHaveLength(1);
    expect(f.watchers[0].setWatchedFiles).toHaveBeenCalledWith(['/TEST-project/two.txt']);
    f.watchers[0].emit({ type: 'change', path: '/TEST-project/one.txt' });
    expect(f.events).toEqual([]);
    f.bridge.dispose();
  });

  it('old-view cleanup remains stop-only after revocation and cannot retire a newer dialog ID', async () => {
    const f = fixture();
    const old = f.bridge.watch(f.request('TEST-old-view'), f.guard);
    f.authorize();
    await old;
    const next = f.bridge.watch(f.request('TEST-new-view'), { isCurrent: () => true });
    f.authorize(1);
    await next;
    f.revoke();
    f.bridge.unwatch(f.request('TEST-old-view'));
    expect(f.watchers[0].stop).toHaveBeenCalledTimes(1);
    expect(f.watchers[1].stop).not.toHaveBeenCalled();
    f.watchers[1].emit({ type: 'change', path: '/TEST-project/one.txt' });
    expect(f.events).toEqual([
      {
        handleId: 'TEST-owner-a',
        watchId: 'TEST-new-view',
        type: 'change',
        path: '/TEST-project/one.txt',
      },
    ]);
    f.bridge.dispose();
  });

  it('dispose cancels pending admission and old callbacks and rejects subsequent work', async () => {
    const f = fixture();
    const first = f.bridge.watch(f.request(), f.guard);
    f.authorize();
    await first;
    const pending = f.bridge.watch(f.request('TEST-pending'), f.guard);
    f.bridge.dispose();
    f.authorize(1);
    await expect(pending).rejects.toThrow('no longer current');
    f.watchers[0].emit({ type: 'change', path: '/TEST-project/one.txt' });
    expect(f.events).toEqual([]);
    expect(f.watchers).toHaveLength(1);
    await expect(f.bridge.watch(f.request(), f.guard)).rejects.toThrow('no longer current');
  });
});

describe('captured review worktree scope', () => {
  it('uses Host root partitions and immutable origin, then reauthorizes notifications before delivery', async () => {
    const f = fixture();
    const request = { ...f.request(), projectPath: '/TEST-main-hint', scope: { taskId: 'TEST-task', memberName: 'worker' },
      filePaths: ['/TEST-worktree/a.ts', '/TEST-other/b.ts'] };
    const pending = f.bridge.watch(request, f.guard);
    request.scope.taskId = 'MUTATED-AFTER-ADMISSION';
    const authorization = { kind: 'review-watch-authorization' as const, projectPath: '/TEST-worktree',
      filePaths: ['/TEST-worktree/a.ts', '/TEST-other/b.ts'], authorizationIdentity: 'a'.repeat(64),
      roots: [{ projectPath: '/TEST-worktree', filePaths: ['/TEST-worktree/a.ts'] },
        { projectPath: '/TEST-other', filePaths: ['/TEST-other/b.ts'] }] };
    f.respond(0, { ok: true, value: authorization });
    await pending;
    expect(f.watchers.map(watcher => watcher.start.mock.calls[0][0])).toEqual(['/TEST-worktree', '/TEST-other']);
    expect(f.requests[0]).toMatchObject({ payload: { scope: { taskId: 'TEST-task', memberName: 'worker' } } });
    f.watchers[0].emit({ type: 'change', path: '/TEST-worktree/a.ts' });
    expect(f.events).toEqual([]);
    for (let i = 0; i < 20; i++) f.watchers[0].emit({ type: 'change', path: '/TEST-worktree/a.ts' });
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]).toMatchObject({ payload: { scope: { taskId: 'TEST-task', memberName: 'worker' } } });
    f.respond(1, { ok: true, value: authorization });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.events).toEqual([expect.objectContaining({ path: '/TEST-worktree/a.ts', watchId: 'TEST-watch' })]);
    f.watchers[1].emit({ type: 'change', path: '/TEST-other/b.ts' });
    f.respond(2, { ok: false, code: 'forbidden', outcome: 'rejected' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.events).toHaveLength(1);
    expect(f.watchers.every(watcher => watcher.stop.mock.calls.length === 1)).toBe(true);
    f.bridge.dispose();
  });
});


it('accepts only finite originating IDs at shared IPC/HTTP admission and portable queries', () => {
  const request = { handle: { handleId: 'TEST-owner' }, watchId: 'TEST-watch', projectPath: '/hint',
    filePaths: ['/captured/file'], scope: { taskId: 'TEST-task', memberName: 'worker' } };
  expect(readCapturedReviewWatchRequest(request).scope).toEqual(request.scope);
  expect(parseReviewQuery('getGitFileLog', { projectPath: '/hint', filePath: '/captured/file', scope: request.scope }).scope).toEqual(request.scope);
  for (const scope of [{ root: '/renderer-selected' }, { taskId: 'TEST-task', actorId: 'renderer-selected' }, { memberName: 'worker', generation: 'renderer-selected' }]) {
    expect(() => readCapturedReviewWatchRequest({ ...request, scope })).toThrow();
    expect(() => parseReviewQuery('authorizeWatch', { projectPath: '/hint', filePaths: request.filePaths, scope })).toThrow();
  }
});
