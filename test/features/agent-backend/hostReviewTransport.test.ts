import {
  bindReviewWriterRequest,
  BOUND_REVIEW_TEAM,
  captureReviewWriterRequest,
  isReviewWriterMethod,
  parseReviewWriterRequest,
} from '@agent-teams/task-change-ledger/review-transport';
import { describe, expect, it, vi } from 'vitest';

import { hostTeamSelectionKey } from '../../../src/features/agent-backend/contracts/teamSelection';
import { createAgentBackendReviewWatchHttpClient } from '../../../src/features/agent-backend/renderer/adapters/http/createAgentBackendReviewWatchHttpClient';
import { createBoundHostReviewApi } from '../../../src/features/agent-backend/renderer/createBoundHostReviewApi';
import { createHostReviewApi } from '../../../src/features/agent-backend/renderer/createHostReviewApi';
import { HostReviewOperationError } from '../../../src/features/agent-backend/renderer/HostReviewOperationError';

import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type {
  AgentBackendReviewWatchApi,
  BackendReviewWatchEvent,
} from '../../../src/features/agent-backend/contracts/reviewWatch';
import type { ReviewAPI } from '../../../src/shared/types/api';

const first = { handleId: 'TEST-review-owner-A' },
  second = { handleId: 'TEST-review-owner-B' };
const aKey = hostTeamSelectionKey(first.handleId),
  bKey = hostTeamSelectionKey(second.handleId);
function fixture() {
  const listeners = new Set<(event: BackendReviewWatchEvent) => void>();
  const backend: AgentBackendApi & AgentBackendReviewWatchApi = {
    getConnections: vi.fn(async () => ({
      state: 'ready' as const,
      bindings: [first, second].map((handle) => ({ handle, label: 'TEST Team', members: [] })),
    })),
    invoke: vi.fn<AgentBackendApi['invoke']>(async (request) => {
      if (request.operation === 'review.lookup') return { ok: true, value: null };
      if (request.operation === 'review.invoke') {
        if (request.payload.request.method === 'previewReject')
          return {
            ok: true,
            value: {
              kind: 'review-writer',
              method: 'previewReject',
              result: { preview: 'TEST-preview', hasConflicts: false },
            },
          };
        if (request.payload.request.method === 'saveEditedFile')
          return {
            ok: true,
            value: { kind: 'review-writer', method: 'saveEditedFile', result: { success: true } },
          };
      }
      return { ok: false, code: 'unavailable', outcome: 'not-dispatched' };
    }),
    watchReviewFiles: vi.fn(async () => {}),
    unwatchReviewFiles: vi.fn(async () => {}),
    onReviewFileChange(callback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
  const legacy = {
    getTaskChanges: vi.fn(),
    getFileContent: vi.fn(),
    previewReject: vi.fn(),
    watchFiles: vi.fn(),
    unwatchFiles: vi.fn(),
  } as unknown as ReviewAPI;
  return {
    backend,
    legacy,
    emit: (event: BackendReviewWatchEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

describe('captured original Review API', () => {
  it('keeps path-only calls and watcher cleanup bound to two originating views on the same path', async () => {
    const f = fixture();
    let aliveA = true;
    const a = createBoundHostReviewApi(
      f.legacy,
      f.backend,
      aKey,
      { taskId: 'task-A' },
      () => () => aliveA
    );
    const b = createBoundHostReviewApi(
      f.legacy,
      f.backend,
      bKey,
      { taskId: 'task-B' },
      () => () => true
    );
    await Promise.all([
      a.previewReject('/TEST/shared.ts', 'before', 'after', [], []),
      b.previewReject('/TEST/shared.ts', 'before', 'after', [], []),
    ]);
    expect(vi.mocked(f.backend.invoke).mock.calls.map(([request]) => request.handle)).toEqual([
      first,
      second,
    ]);
    const onA = vi.fn(),
      onB = vi.fn();
    const offA = a.onExternalFileChange(onA),
      offB = b.onExternalFileChange(onB);
    await a.watchFiles('/TEST/project', ['/TEST/shared.ts']);
    await b.watchFiles('/TEST/project', ['/TEST/shared.ts']);
    const watchA = vi.mocked(f.backend.watchReviewFiles).mock.calls[0][0],
      watchB = vi.mocked(f.backend.watchReviewFiles).mock.calls[1][0];
    expect(watchA.watchId).not.toBe(watchB.watchId);
    f.emit({
      handleId: first.handleId,
      watchId: watchA.watchId,
      path: '/TEST/shared.ts',
      type: 'change',
    });
    expect(onA).toHaveBeenCalledOnce();
    expect(onB).not.toHaveBeenCalled();
    aliveA = false;
    await expect(a.watchFiles('/TEST/project', ['/TEST/shared.ts'])).rejects.toThrow(
      'context changed'
    );
    await a.unwatchFiles();
    expect(f.backend.unwatchReviewFiles).toHaveBeenCalledExactlyOnceWith({
      handle: first,
      watchId: watchA.watchId,
    });
    f.emit({
      handleId: first.handleId,
      watchId: watchA.watchId,
      path: '/TEST/shared.ts',
      type: 'change',
    });
    f.emit({
      handleId: second.handleId,
      watchId: watchB.watchId,
      path: '/TEST/shared.ts',
      type: 'change',
    });
    expect(onA).toHaveBeenCalledOnce();
    expect(onB).toHaveBeenCalledOnce();
    expect(f.backend.getConnections).toHaveBeenCalledTimes(2);
    expect(f.legacy.previewReject).not.toHaveBeenCalled();
    expect(f.legacy.watchFiles).not.toHaveBeenCalled();
    offA();
    offB();
  });
  it('cancels a pending watch admission when its originating view cleans up', async () => {
    const f = fixture();
    let release!: (value: Awaited<ReturnType<AgentBackendApi['getConnections']>>) => void;
    vi.mocked(f.backend.getConnections).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const api = createBoundHostReviewApi(
      f.legacy,
      f.backend,
      aKey,
      { taskId: 'TEST-task' },
      () => () => true
    );
    const pending = api.watchFiles('/TEST/project', ['/TEST/file.ts']);
    const cleanup = api.unwatchFiles();
    release({ state: 'ready', bindings: [{ handle: first, label: 'TEST', members: [] }] });
    await Promise.all([pending, cleanup]);
    expect(f.backend.watchReviewFiles).not.toHaveBeenCalled();
    expect(f.backend.unwatchReviewFiles).toHaveBeenCalledOnce();
  });
  it('captures original scope before await and retains UNKNOWN privately without re-dispatching', async () => {
    const f = fixture();
    let release!: (value: Awaited<ReturnType<AgentBackendApi['getConnections']>>) => void;
    vi.mocked(f.backend.getConnections).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    vi.mocked(f.backend.invoke).mockResolvedValueOnce({
      ok: false,
      code: 'hold',
      outcome: 'unknown',
    });
    const api = createBoundHostReviewApi(
      f.legacy,
      f.backend,
      aKey,
      { taskId: 'TEST-original-task' },
      () => () => true
    );
    const scope = { teamName: aKey, taskId: 'TEST-original-task' };
    const pending = api
      .saveEditedFile(scope, '/TEST/file.ts', 'TEST-private-after', 'before')
      .catch((error) => error as unknown);
    scope.taskId = 'WRONG-new-task';
    release({ state: 'ready', bindings: [{ handle: first, label: 'TEST', members: [] }] });
    const error = await pending;
    expect(error).toBeInstanceOf(HostReviewOperationError);
    const unknown = error as HostReviewOperationError;
    expect(unknown.outcome).toBe('unknown');
    expect(JSON.stringify(unknown)).not.toContain('TEST-private-after');
    expect(f.backend.invoke).toHaveBeenCalledOnce();
    const original = unknown.originalRequest;
    expect(original.operation).toBe('review.invoke');
    if (original.operation !== 'review.invoke') throw new Error('Wrong retained request');
    expect(original.payload.scope).toEqual({ taskId: 'TEST-original-task' });
    expect(original.payload.request.args[0]).toEqual({
      teamName: BOUND_REVIEW_TEAM,
      taskId: 'TEST-original-task',
    });
    const lookup = await unknown.lookupOriginalOutcome(f.backend);
    expect(lookup).toBeNull();
    expect(f.backend.invoke).toHaveBeenLastCalledWith({
      handle: first,
      commandId: original.commandId,
      operation: 'review.lookup',
      payload: { scope: original.payload.scope, expected: original.payload.request },
    });
    expect(f.backend.getConnections).toHaveBeenCalledOnce();
    expect(f.legacy.getFileContent).not.toHaveBeenCalled();
  });
  it('HTTP stream loss invalidates exact snapshots without FS events and preserves an in-flight original lookup', async () => {
    const f = fixture();
    let status!: (value: 'ready' | 'stream-lost' | 'stream-reconnected') => void;
    const watch = createAgentBackendReviewWatchHttpClient({
      async post() {},
      subscribe(_callback, onStatus) {
        status = onStatus!;
        return () => {};
      },
    });
    Object.assign(f.backend, watch);
    const api = createBoundHostReviewApi(
      f.legacy,
      f.backend,
      aKey,
      { taskId: 'TEST-task' },
      () => () => true
    );
    const fsEvents = vi.fn();
    const stop = api.onExternalFileChange(fsEvents);
    await api.watchFiles('/TEST', ['/TEST/file.ts']);
    status('ready');
    let finish!: (value: Awaited<ReturnType<AgentBackendApi['invoke']>>) => void;
    vi.mocked(f.backend.invoke).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = api
      .saveEditedFile({ teamName: aKey, taskId: 'TEST-task' }, '/TEST/file.ts', 'after', 'before')
      .catch((error) => error as unknown);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const original = vi.mocked(f.backend.invoke).mock.calls[0][0];
    status('stream-lost');
    status('stream-reconnected');
    finish({ ok: false, code: 'hold', outcome: 'unknown' });
    const outcome = await pending;
    expect(outcome).toBeInstanceOf(HostReviewOperationError);
    expect(fsEvents).not.toHaveBeenCalled();
    await expect(
      api.saveEditedFile(
        { teamName: aKey, taskId: 'TEST-task' },
        '/TEST/file.ts',
        'later',
        'before'
      )
    ).rejects.toThrow('Reopen Changes');
    expect(f.backend.invoke).toHaveBeenCalledTimes(1);
    await expect(
      (outcome as HostReviewOperationError).lookupOriginalOutcome(f.backend)
    ).resolves.toBeNull();
    expect(f.backend.invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: 'review.lookup',
        commandId: original.commandId,
        handle: original.handle,
      })
    );
    stop();
    const reopened = createBoundHostReviewApi(
      f.legacy,
      f.backend,
      aKey,
      { taskId: 'TEST-task' },
      () => () => true
    );
    const stopReopened = reopened.onExternalFileChange(fsEvents);
    await reopened.watchFiles('/TEST', ['/TEST/file.ts']);
    status('ready');
    await expect(
      reopened.previewReject('/TEST/file.ts', 'before', 'after', [], [])
    ).resolves.toEqual({ preview: 'TEST-preview', hasConflicts: false });
    await expect(
      reopened.saveEditedFile(
        { teamName: aKey, taskId: 'TEST-task' },
        '/TEST/file.ts',
        'after',
        'before'
      )
    ).resolves.toEqual({ success: true });
    stopReopened();
  });

  it('never routes an unavailable Host or an unbound Host content read into the legacy writer', async () => {
    const f = fixture();
    vi.mocked(f.backend.getConnections).mockResolvedValue({ state: 'hold', bindings: [] });
    const api = createHostReviewApi(f.legacy, f.backend, () => () => true);
    await expect(api.getTaskChanges(aKey, 'TEST-task')).rejects.toThrow('unavailable');
    expect(() => api.getFileContent(aKey, undefined, '/TEST/file.ts', [])).toThrow(
      'originating review scope'
    );
    expect(f.legacy.getTaskChanges).not.toHaveBeenCalled();
    expect(f.legacy.getFileContent).not.toHaveBeenCalled();
    expect(f.backend.invoke).not.toHaveBeenCalled();
  });
});

describe('finite review tuple transport', () => {
  it('preserves optional defaults, exact Team binding, and known method denominator', () => {
    const captured = captureReviewWriterRequest(
      { method: 'getFileContent', args: [aKey, undefined, '/TEST/file.ts'] },
      aKey
    );
    expect(captured.args[1]).toBeNull();
    const bound = bindReviewWriterRequest(captured, 'canonical-team');
    expect(bound).toEqual({
      method: 'getFileContent',
      args: ['canonical-team', undefined, '/TEST/file.ts', undefined],
    });
    expect(isReviewWriterMethod('dispose')).toBe(false);
    expect(isReviewWriterMethod('saveEditedFile')).toBe(true);
    expect(() => parseReviewWriterRequest({ method: 'dispose', args: [] })).toThrow();
    expect(() =>
      parseReviewWriterRequest({
        method: 'rejectFile',
        args: [{ teamName: 'foreign-team', taskId: 'TEST-task' }, '/TEST/file.ts'],
      })
    ).toThrow();
    expect(() =>
      captureReviewWriterRequest(
        { method: 'rejectFile', args: [{ teamName: bKey, taskId: 'TEST-task' }, '/TEST/file.ts'] },
        aKey
      )
    ).toThrow();
  });
});

it('forwards only the bound originating scope to watch and Git even when caller project hints differ', async () => {
  const f = fixture();
  const origin = { taskId: 'TEST-task', memberName: 'alice' };
  const api = createBoundHostReviewApi(f.legacy, f.backend, aKey, origin, () => () => true);
  origin.taskId = 'MUTATED';
  await api.watchFiles('/TEST-untrusted-hint', ['/TEST-captured-worktree/file.ts']);
  expect(f.backend.watchReviewFiles).toHaveBeenCalledWith(expect.objectContaining({
    scope: { taskId: 'TEST-task', memberName: 'alice' }, projectPath: '/TEST-untrusted-hint',
  }));
  vi.mocked(f.backend.invoke).mockResolvedValueOnce({ ok: true, value: { kind: 'review-git-log', value: [] } });
  await api.getGitFileLog('/TEST-untrusted-hint', '/TEST-captured-worktree/file.ts');
  expect(f.backend.invoke).toHaveBeenLastCalledWith(expect.objectContaining({
    operation: 'review.getGitFileLog', payload: { projectPath: '/TEST-untrusted-hint',
      filePath: '/TEST-captured-worktree/file.ts', scope: { taskId: 'TEST-task', memberName: 'alice' } },
  }));
});
