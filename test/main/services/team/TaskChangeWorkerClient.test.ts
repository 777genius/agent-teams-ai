import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskChangeWorkerClient } from '../../../../src/main/services/team/TaskChangeWorkerClient';

import type { TaskChangeSetV2 } from '../../../../src/shared/types';
import type { TaskChangeWorkerRequest, TaskChangeWorkerResponse } from '../../../../src/main/services/team/taskChangeWorkerTypes';

class FakeWorker {
  readonly posted: TaskChangeWorkerRequest[] = [];
  readonly terminate = vi.fn(async () => 0);
  private readonly listeners: {
    message: Array<(message: TaskChangeWorkerResponse) => void>;
    error: Array<(error: Error) => void>;
    exit: Array<(code: number) => void>;
  } = {
    message: [],
    error: [],
    exit: [],
  };

  on(event: 'message' | 'error' | 'exit', listener: ((value: any) => void) & ((value: any) => void)) {
    if (event === 'message') this.listeners.message.push(listener as (message: TaskChangeWorkerResponse) => void);
    if (event === 'error') this.listeners.error.push(listener as (error: Error) => void);
    if (event === 'exit') this.listeners.exit.push(listener as (code: number) => void);
    return this;
  }

  postMessage(message: TaskChangeWorkerRequest): void {
    this.posted.push(message);
  }

  emitMessage(message: TaskChangeWorkerResponse): void {
    for (const listener of this.listeners.message) {
      listener(message);
    }
  }

  emitError(error: Error): void {
    for (const listener of this.listeners.error) {
      listener(error);
    }
  }

  emitExit(code: number): void {
    for (const listener of this.listeners.exit) {
      listener(code);
    }
  }
}

function makePayload(taskId = 'task-1') {
  return {
    teamName: 'team-a',
    taskId,
    taskMeta: {
      owner: 'alice',
      status: 'completed',
      intervals: [{ startedAt: '2026-03-01T10:00:00.000Z', completedAt: '2026-03-01T10:10:00.000Z' }],
      reviewState: 'none' as const,
      historyEvents: [],
    },
    effectiveOptions: {
      owner: 'alice',
      status: 'completed',
      intervals: [{ startedAt: '2026-03-01T10:00:00.000Z', completedAt: '2026-03-01T10:10:00.000Z' }],
    },
    projectPath: '/repo',
    includeDetails: false,
  };
}

function makeResult(taskId = 'task-1', filePath = '/repo/src/file.ts'): TaskChangeSetV2 {
  return {
    teamName: 'team-a',
    taskId,
    files: [
      {
        filePath,
        relativePath: 'src/file.ts',
        snippets: [],
        linesAdded: 1,
        linesRemoved: 0,
        isNewFile: true,
      },
    ],
    totalFiles: 1,
    totalLinesAdded: 1,
    totalLinesRemoved: 0,
    confidence: 'high' as const,
    computedAt: '2026-03-01T12:00:00.000Z',
    scope: {
      taskId,
      memberName: 'alice',
      startLine: 0,
      endLine: 0,
      startTimestamp: '',
      endTimestamp: '',
      toolUseIds: [],
      filePaths: [filePath],
      confidence: { tier: 1, label: 'high', reason: 'test fixture' },
    },
    warnings: [],
  };
}

describe('TaskChangeWorkerClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves successful worker responses', async () => {
    const workers: FakeWorker[] = [];
    const client = new TaskChangeWorkerClient({
      workerPath: '/tmp/task-change-worker.cjs',
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as any;
      },
      enabled: true,
    });

    const promise = client.computeTaskChanges(makePayload());
    const request = workers[0]!.posted[0]!;
    workers[0]!.emitMessage({ id: request.id, ok: true, result: makeResult() });

    await expect(promise).resolves.toEqual(makeResult());
  });

  it('times out the active request, terminates the worker, and recreates it on the next call', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const client = new TaskChangeWorkerClient({
      workerPath: '/tmp/task-change-worker.cjs',
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as any;
      },
      timeoutMs: 25,
      enabled: true,
    });

    const firstPromise = client.computeTaskChanges(makePayload('task-timeout'));
    const firstExpectation = expect(firstPromise).rejects.toThrow('Worker call timeout');
    await vi.advanceTimersByTimeAsync(25);
    await firstExpectation;
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);

    const secondPromise = client.computeTaskChanges(makePayload('task-next'));
    const request = workers[1]!.posted[0]!;
    workers[1]!.emitMessage({
      id: request.id,
      ok: true,
      result: makeResult('task-next', '/repo/src/next.ts'),
    });

    await expect(secondPromise).resolves.toEqual(makeResult('task-next', '/repo/src/next.ts'));
    expect(workers).toHaveLength(2);
  });

  it('rejects all pending requests on worker error and clears queued work', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const workers: FakeWorker[] = [];
    const client = new TaskChangeWorkerClient({
      workerPath: '/tmp/task-change-worker.cjs',
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as any;
      },
      enabled: true,
    });

    const first = client.computeTaskChanges(makePayload('task-1'));
    const second = client.computeTaskChanges(makePayload('task-2'));
    workers[0]!.emitError(new Error('boom'));

    await expect(first).rejects.toThrow('boom');
    await expect(second).rejects.toThrow('boom');

    const third = client.computeTaskChanges(makePayload('task-3'));
    const request = workers[1]!.posted[0]!;
    workers[1]!.emitMessage({ id: request.id, ok: true, result: makeResult('task-3') });
    await expect(third).resolves.toEqual(makeResult('task-3'));
  });

  it('rejects all pending requests on worker exit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const workers: FakeWorker[] = [];
    const client = new TaskChangeWorkerClient({
      workerPath: '/tmp/task-change-worker.cjs',
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as any;
      },
      enabled: true,
    });

    const first = client.computeTaskChanges(makePayload('task-1'));
    const second = client.computeTaskChanges(makePayload('task-2'));
    workers[0]!.emitExit(9);

    await expect(first).rejects.toThrow('Worker exited with code 9');
    await expect(second).rejects.toThrow('Worker exited with code 9');
  });

  it('executes queued requests sequentially in FIFO order', async () => {
    const workers: FakeWorker[] = [];
    const client = new TaskChangeWorkerClient({
      workerPath: '/tmp/task-change-worker.cjs',
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as any;
      },
      enabled: true,
    });

    const first = client.computeTaskChanges(makePayload('task-1'));
    const second = client.computeTaskChanges(makePayload('task-2'));

    expect(workers[0]!.posted).toHaveLength(1);
    expect(workers[0]!.posted[0]!.payload.taskId).toBe('task-1');

    workers[0]!.emitMessage({
      id: workers[0]!.posted[0]!.id,
      ok: true,
      result: makeResult('task-1'),
    });

    expect(workers[0]!.posted).toHaveLength(2);
    expect(workers[0]!.posted[1]!.payload.taskId).toBe('task-2');

    workers[0]!.emitMessage({
      id: workers[0]!.posted[1]!.id,
      ok: true,
      result: makeResult('task-2'),
    });

    await expect(first).resolves.toEqual(makeResult('task-1'));
    await expect(second).resolves.toEqual(makeResult('task-2'));
  });

  it('reports unavailable when the worker file is missing', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new TaskChangeWorkerClient({
      workerPath: null,
      enabled: true,
    });

    expect(client.isAvailable()).toBe(false);
  });
});
