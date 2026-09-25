/* eslint-disable @typescript-eslint/require-await -- Async fakes implement asynchronous port contracts. */
import { createHash } from 'node:crypto';

import {
  type ExternalFileObservationSource,
  type ExternalFileReconciliationRequest,
  type ExternalWriterObservationStateStore,
  ExternalWriterObserver,
  type ExternalWriterWatchCallbacks,
  type FileObservationStateCheckpoint,
} from '@features/external-writer-coordination';
import { NodeExternalContentChecksum } from '@features/external-writer-coordination/main/infrastructure/NodeExternalContentChecksum';
import { createSupervisorTaskSelfWriteCoordinator } from '@main/composition/hosted/hostedTaskBoardSelfWrite';
import {
  ProductTaskCommittedTargets,
  ProductTaskMutationAuthority,
} from '@main/composition/hosted/productTaskMutationAuthority';
import {
  createQueryContext,
  parseBootId,
  parseDeploymentId,
  parseTeamId,
  type QueryContext,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type { HostedTaskBoardCommittedTarget } from '@main/composition/hosted/hostedTaskBoardMutationFileAuthorityTypes';
import type { HostedTaskBoardSelfWriteCoordinator } from '@main/composition/hosted/hostedTaskBoardSelfWrite';
import type {
  HostedTaskBoardAuthorityMutationRequest,
  HostedTaskBoardAuthorityMutationResult,
} from '@features/team-task-board/main/hosted';

const TEAM_ID = parseTeamId(`team_${'a'.repeat(32)}`);
const COMMAND_ID = 'command_product-task-mutation';
const TASK_POSTIMAGE = `${JSON.stringify({ id: '1', subject: 'Product write' }, null, 2)}\n`;
const scope = { teamId: TEAM_ID, featureKey: 'tasks' } as const;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function context(): QueryContext {
  return createQueryContext({
    actorId: `actor_${'b'.repeat(64)}`,
    sessionId: 'session_product-task-mutation',
    deploymentId: parseDeploymentId(`deployment_${'c'.repeat(32)}`),
    bootId: parseBootId(`boot_${'d'.repeat(32)}`),
    requestId: 'request_product-task-mutation',
    authorizedScope: 'scope_product-task-mutation',
    deadlineAtMs: Date.now() + 60_000,
    signal: new AbortController().signal,
  });
}

function request(
  kind: 'update_status' | 'update_relationship' = 'update_status'
): HostedTaskBoardAuthorityMutationRequest {
  return Object.freeze({
    command: { kind, commandId: COMMAND_ID, teamId: TEAM_ID } as never,
    payloadFingerprint: 'f'.repeat(43),
  });
}

function result(kind: string): HostedTaskBoardAuthorityMutationResult {
  return Object.freeze({ kind }) as HostedTaskBoardAuthorityMutationResult;
}

const PUBLISHED: readonly HostedTaskBoardCommittedTarget[] = Object.freeze([
  { kind: 'task', parent: 'tasks', name: '1.json', postimage: TASK_POSTIMAGE },
  { kind: 'kanban', parent: 'team', name: 'kanban-state.json', postimage: '{}\n' },
  { kind: 'ledger', parent: 'team', name: 'ledger.json', postimage: '{}\n' },
]);

function harness(
  admit: (
    record: (context: QueryContext, targets: readonly HostedTaskBoardCommittedTarget[]) => void,
    context: QueryContext
  ) => Promise<HostedTaskBoardAuthorityMutationResult>,
  selfWrites?: HostedTaskBoardSelfWriteCoordinator
) {
  const order: string[] = [];
  const committed = new ProductTaskCommittedTargets();
  const coordinator: HostedTaskBoardSelfWriteCoordinator = selfWrites ?? {
    beginTaskSelfWrite: vi.fn(async (operationId: string) => {
      order.push(`begin:${operationId}`);
    }),
    completeTaskSelfWrite: vi.fn(async (operationId: string) => {
      order.push(`complete:${operationId}`);
    }),
    abortTaskSelfWrite: vi.fn(async (operationId: string) => {
      order.push(`abort:${operationId}`);
    }),
  };
  const files = {
    bindGrantFence: vi.fn(),
    admitTaskMutation: vi.fn(
      async (_request: HostedTaskBoardAuthorityMutationRequest, query: QueryContext) => {
        order.push('files');
        return admit((ctx, targets) => committed.record(ctx, targets), query);
      }
    ),
  };
  const commitAuthority = { bind: vi.fn() };
  const withTaskWrite = vi.fn(async (_teamId: string, work: () => Promise<unknown>) => {
    order.push('lock');
    try {
      return await work();
    } finally {
      order.push('unlock');
    }
  });
  const serialization = {
    withTaskWrite: withTaskWrite as unknown as <T>(
      teamId: string,
      work: () => Promise<T>
    ) => Promise<T>,
  };
  const authority = new ProductTaskMutationAuthority(
    files,
    serialization,
    commitAuthority,
    coordinator,
    committed
  );
  return { authority, order, files, commitAuthority, withTaskWrite, coordinator };
}

describe('Product task mutation authority', () => {
  it('binds the fence to both the Product decision and the file authority', () => {
    const { authority, files, commitAuthority } = harness(async () => result('committed'));
    const query = context();
    const fence = { ownerEffectFence: {} as never, revalidate: async () => true };
    authority.bindGrantFence(query, fence);
    expect(commitAuthority.bind).toHaveBeenCalledWith(query, fence);
    expect(files.bindGrantFence).toHaveBeenCalledWith(query, fence);
  });

  it('begins under the lock, commits, then completes with task-only postimage checksums', async () => {
    const { authority, order, coordinator } = harness(async (record, query) => {
      record(query, PUBLISHED);
      return result('committed');
    });
    await expect(authority.admitTaskMutation(request(), context())).resolves.toEqual({
      kind: 'committed',
    });
    expect(order).toEqual([
      'lock',
      `begin:${COMMAND_ID}`,
      'files',
      'unlock',
      `complete:${COMMAND_ID}`,
    ]);
    expect(coordinator.completeTaskSelfWrite).toHaveBeenCalledWith(COMMAND_ID, [
      { fileKey: '1', expectedChecksum: sha256(Buffer.from(TASK_POSTIMAGE, 'utf8')) },
    ]);
    expect(coordinator.abortTaskSelfWrite).not.toHaveBeenCalled();
  });

  it('completes a replay whose request forward-recovered its own prepared WAL', async () => {
    const { authority, order } = harness(async (record, query) => {
      record(query, PUBLISHED);
      return result('idempotent_replay');
    });
    await authority.admitTaskMutation(request(), context());
    expect(order.at(-1)).toBe(`complete:${COMMAND_ID}`);
  });

  it.each(['idempotent_replay', 'conflict', 'stale_revision', 'stale_generation', 'unsafe_active'])(
    'aborts the self-write operation when %s published nothing',
    async (kind) => {
      const { authority, order, coordinator } = harness(async () => result(kind));
      await expect(authority.admitTaskMutation(request(), context())).resolves.toEqual({ kind });
      expect(order.at(-1)).toBe(`abort:${COMMAND_ID}`);
      expect(coordinator.completeTaskSelfWrite).not.toHaveBeenCalled();
    }
  );

  it('aborts and fails closed when the file authority throws', async () => {
    const { authority, order } = harness(async () => {
      throw new Error('file-authority-exploded');
    });
    await expect(authority.admitTaskMutation(request(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(order).toEqual([
      'lock',
      `begin:${COMMAND_ID}`,
      'files',
      'unlock',
      `abort:${COMMAND_ID}`,
    ]);
  });

  it('never begins a self-write when the Product lock is busy', async () => {
    const { authority, withTaskWrite, coordinator, files } = harness(async () =>
      result('committed')
    );
    withTaskWrite.mockRejectedValueOnce(new Error('product-authority-lock-transient-busy'));
    await expect(authority.admitTaskMutation(request(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(coordinator.beginTaskSelfWrite).not.toHaveBeenCalled();
    expect(coordinator.abortTaskSelfWrite).not.toHaveBeenCalled();
    expect(files.admitTaskMutation).not.toHaveBeenCalled();
  });

  it('refuses update_relationship without a lock, self-write, or file write', async () => {
    const { authority, order } = harness(async () => result('committed'));
    await expect(
      authority.admitTaskMutation(request('update_relationship'), context())
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(order).toEqual([]);
  });

  it('is unavailable without writing when no external-writer supervisor is running', async () => {
    const admit = vi.fn(async () => result('committed'));
    const { authority, files } = harness(
      admit,
      createSupervisorTaskSelfWriteCoordinator(() => null)
    );
    await expect(authority.admitTaskMutation(request(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(files.admitTaskMutation).not.toHaveBeenCalled();
  });

  it('reports unavailable when completion fails after commit, then replays idempotently', async () => {
    let committedOnce = false;
    const { authority, order, coordinator } = harness(async (record, query) => {
      if (committedOnce) return result('idempotent_replay');
      committedOnce = true;
      record(query, PUBLISHED);
      return result('committed');
    });
    vi.mocked(coordinator.completeTaskSelfWrite).mockRejectedValueOnce(
      new Error('self-write-persist-failed')
    );
    await expect(authority.admitTaskMutation(request(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(order.at(-1)).toBe(`abort:${COMMAND_ID}`);
    await expect(authority.admitTaskMutation(request(), context())).resolves.toEqual({
      kind: 'idempotent_replay',
    });
  });
});

class MemoryStateStore implements ExternalWriterObservationStateStore {
  checkpoint: FileObservationStateCheckpoint | null = null;
  async load(): Promise<FileObservationStateCheckpoint | null> {
    return this.checkpoint;
  }
  async consumeCleanHandoffEligibility(): Promise<FileObservationStateCheckpoint | null> {
    return null;
  }
  async listHotTeamIds(): Promise<readonly (typeof TEAM_ID)[]> {
    return [];
  }
  async save(checkpoint: FileObservationStateCheckpoint): Promise<void> {
    this.checkpoint = checkpoint;
  }
  async saveCleanHandoffEligibility(checkpoint: FileObservationStateCheckpoint): Promise<void> {
    await this.save(checkpoint);
  }
}

function observerHarness() {
  const contents = new Map<string, Uint8Array>([['1', Buffer.from('{"id":"1"}\n', 'utf8')]]);
  const reconciliations: ExternalFileReconciliationRequest[] = [];
  let callbacks: ExternalWriterWatchCallbacks | null = null;
  let now = 0;
  let generation = 0;
  const source: ExternalFileObservationSource = {
    async stat(registration) {
      const content = contents.get(registration.fileKey);
      return content
        ? {
            kind: 'file',
            contained: true,
            byteLength: content.byteLength,
            device: 'device-1',
            inode: 'inode-1',
            modifiedTimeNs: sha256(content),
            changedTimeNs: sha256(content),
          }
        : {
            kind: 'missing',
            contained: true,
            byteLength: 0,
            device: null,
            inode: null,
            modifiedTimeNs: null,
            changedTimeNs: null,
          };
    },
    async read(registration) {
      return contents.get(registration.fileKey)!;
    },
    async confirmAbsentByParentRescan() {
      return true;
    },
  };
  const observer = new ExternalWriterObserver(
    {
      watch: {
        async start(watchCallbacks) {
          callbacks = watchCallbacks;
          return { close: async () => undefined };
        },
      },
      catalog: {
        async listScopes() {
          return [scope];
        },
        async listRegistrations() {
          return [
            { scope, fileKey: '1', maxBytes: 4_096, attributionPolicy: 'external_file_only' },
          ];
        },
      },
      source,
      // The production checksum port: Product effects must hash identical published bytes.
      checksums: new NodeExternalContentChecksum(),
      reconciliation: {
        async getResult() {
          return null;
        },
        async reconcile(input) {
          reconciliations.push(input);
          generation += 1;
          return {
            outcome: 'accepted_change',
            sourceGeneration: generation,
            featureRevision: generation,
          };
        },
      },
      stateStore: new MemoryStateStore(),
      clock: {
        nowMs: () => now,
        sleep: async (delayMs: number) => {
          now += delayMs;
        },
      },
    },
    {
      retryDelayMs: 1,
      atomicReplaceDebounceMs: 1,
      stableReadDeadlineMs: 100,
      shutdownDrainDeadlineMs: 100,
    }
  );
  // Mirrors the supervisor's task-scope bracketing over the long-lived observer.
  const selfWrites: HostedTaskBoardSelfWriteCoordinator = {
    beginTaskSelfWrite: (operationId, teamId) =>
      observer.beginSelfWriteOperation(operationId, { teamId, featureKey: 'tasks' }),
    completeTaskSelfWrite: (operationId, effects) =>
      observer.completeSelfWriteOperation(operationId, effects),
    abortTaskSelfWrite: (operationId) => observer.abortSelfWriteOperation(operationId),
  };
  return {
    observer,
    contents,
    reconciliations,
    selfWrites,
    write(fileKey: string, text: string) {
      contents.set(fileKey, Buffer.from(text, 'utf8'));
      callbacks!.onNotification({ kind: 'rename', scope, fileKey });
    },
  };
}

describe('Product task mutation authority with the external-writer observer', () => {
  it('does not report a Product write as external, but still reports a later agent write', async () => {
    const observed = observerHarness();
    await observed.observer.start();
    const baseline = observed.reconciliations.length;
    const { authority } = harness(async (record, query) => {
      observed.write('1', TASK_POSTIMAGE);
      record(query, PUBLISHED);
      return result('committed');
    }, observed.selfWrites);

    await expect(authority.admitTaskMutation(request(), context())).resolves.toEqual({
      kind: 'committed',
    });
    await observed.observer.rescanScope(scope);
    expect(observed.reconciliations).toHaveLength(baseline);

    observed.write('1', `${JSON.stringify({ id: '1', subject: 'Agent write' }, null, 2)}\n`);
    await observed.observer.rescanScope(scope);
    expect(observed.reconciliations).toHaveLength(baseline + 1);
    expect(observed.reconciliations.at(-1)).toMatchObject({
      registration: { fileKey: '1' },
      actor: { kind: 'external_file' },
    });
  });

  it('reports a Product postimage as external when the operation aborted', async () => {
    const observed = observerHarness();
    await observed.observer.start();
    const baseline = observed.reconciliations.length;
    const { authority } = harness(async () => {
      observed.write('1', TASK_POSTIMAGE);
      throw new Error('crash-after-publish');
    }, observed.selfWrites);

    await expect(authority.admitTaskMutation(request(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
    await observed.observer.rescanScope(scope);
    expect(observed.reconciliations).toHaveLength(baseline + 1);
  });
});
