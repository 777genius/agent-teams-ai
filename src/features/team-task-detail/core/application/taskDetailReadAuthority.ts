import {
  isSameTaskDetailReadScope,
  taskDetailFullResourceKey,
  type TaskDetailReadHandle,
  type TaskDetailReadResult,
  type TaskDetailReadScope,
  type TaskDetailReadToken,
  taskDetailSnapshotResourceKey,
} from '../domain/taskDetailReadProvenance';

import type { TaskDetailIdentity } from '../../contracts';

type ReadCallback<T> = (token: TaskDetailReadToken, markPhysicalStart: () => void) => Promise<T>;

interface TaskDetailReadRecord {
  key: string;
  resource: 'snapshot' | 'full';
  sourceEpoch: number;
  latestRequestSerial: number;
  owner: TaskDetailPendingRead<unknown> | null;
  active: TaskDetailActiveRead<unknown> | null;
  successor: TaskDetailPendingRead<unknown> | null;
}

interface TaskDetailPendingRead<T> {
  token: TaskDetailReadToken;
  handle: TaskDetailReadHandle<T>;
  resolveResult: (result: TaskDetailReadResult<T>) => void;
  read: ReadCallback<T>;
  requested: boolean;
  started: boolean;
  superseded: boolean;
}

interface TaskDetailActiveRead<T> {
  pending: TaskDetailPendingRead<T>;
  invalidated: boolean;
}

export interface TaskDetailReadAuthority {
  readSnapshot<T>(
    teamName: string,
    scope: TaskDetailReadScope,
    read: ReadCallback<T>,
    options?: { forceNew?: boolean; mode?: 'full' | 'thin'; deferPhysicalStart?: boolean }
  ): TaskDetailReadHandle<T>;
  readFull<T>(
    identity: TaskDetailIdentity,
    scope: TaskDetailReadScope,
    read: ReadCallback<T>
  ): TaskDetailReadHandle<T>;
  invalidateSnapshot(teamName: string, contextId: string): void;
  invalidateFull(identity: TaskDetailIdentity): void;
  isTokenCurrent(token: TaskDetailReadToken, scope?: TaskDetailReadScope): boolean;
}

export function createTaskDetailReadAuthority(): TaskDetailReadAuthority {
  const records = new Map<string, TaskDetailReadRecord>();
  let latestPhysicalStartOrder = 0;

  const ensureRecord = (key: string, resource: 'snapshot' | 'full'): TaskDetailReadRecord => {
    let record = records.get(key);
    if (!record) {
      record = {
        key,
        resource,
        sourceEpoch: 1,
        latestRequestSerial: 0,
        owner: null,
        active: null,
        successor: null,
      };
      records.set(key, record);
    }
    return record;
  };

  const createPending = <T>(
    record: TaskDetailReadRecord,
    scope: TaskDetailReadScope,
    read: ReadCallback<T>
  ): TaskDetailPendingRead<T> => {
    const token: TaskDetailReadToken = {
      resource: record.resource,
      key: record.key,
      sourceEpoch: record.sourceEpoch,
      serial: ++record.latestRequestSerial,
      physicalStartOrder: 0,
      scope,
    };
    let resolveResult!: (result: TaskDetailReadResult<T>) => void;
    const result = new Promise<TaskDetailReadResult<T>>((resolve) => {
      resolveResult = resolve;
    });
    return {
      token,
      handle: { token, result },
      resolveResult,
      read,
      requested: true,
      started: false,
      superseded: false,
    };
  };

  const startPending = <T>(
    record: TaskDetailReadRecord,
    pending: TaskDetailPendingRead<T>,
    deferPhysicalStart: boolean
  ): TaskDetailReadHandle<T> => {
    if (pending.started) return pending.handle;
    pending.started = true;
    const active: TaskDetailActiveRead<T> = { pending, invalidated: false };
    if (!pending.superseded) {
      record.owner = pending as TaskDetailPendingRead<unknown>;
      record.active = active as TaskDetailActiveRead<unknown>;
    }
    let physicalStartMarked = false;
    const markPhysicalStart = (): void => {
      if (physicalStartMarked) return;
      physicalStartMarked = true;
      pending.token.physicalStartOrder = ++latestPhysicalStartOrder;
    };
    if (!deferPhysicalStart) markPhysicalStart();

    void (async () => {
      try {
        const value = await pending.read(pending.token, markPhysicalStart);
        pending.resolveResult({ token: pending.token, value });
      } catch (error) {
        pending.resolveResult({ token: pending.token, error });
      } finally {
        if (record.active === (active as TaskDetailActiveRead<unknown>)) {
          record.active = null;
          const successor = record.successor;
          record.successor = null;
          if (active.invalidated && successor?.requested) {
            record.owner = successor as TaskDetailPendingRead<unknown>;
            void startPending(record, successor as TaskDetailPendingRead<unknown>, false);
          }
        }
      }
    })();
    return pending.handle;
  };

  const runPending = <T>(
    record: TaskDetailReadRecord,
    pending: TaskDetailPendingRead<T>,
    deferPhysicalStart = false
  ): TaskDetailReadHandle<T> => {
    pending.requested = true;
    return startPending(record, pending, deferPhysicalStart);
  };

  const readResource = <T>(
    key: string,
    resource: 'snapshot' | 'full',
    scope: TaskDetailReadScope,
    read: ReadCallback<T>,
    options?: { forceNew?: boolean; deferPhysicalStart?: boolean }
  ): TaskDetailReadHandle<T> => {
    const record = ensureRecord(key, resource);
    const join = (pending: TaskDetailPendingRead<unknown>): TaskDetailReadHandle<T> => {
      pending.requested = true;
      if (pending.started) return pending.handle as TaskDetailReadHandle<T>;
      if (record.active === null) {
        return runPending(record, pending as TaskDetailPendingRead<T>, options?.deferPhysicalStart);
      }
      return pending.handle as TaskDetailReadHandle<T>;
    };

    if (!options?.forceNew && record.owner && !record.owner.superseded) {
      if (isSameTaskDetailReadScope(record.owner.token.scope, scope)) {
        return join(record.owner);
      }
    }
    if (!options?.forceNew && record.successor && !record.successor.superseded) {
      if (isSameTaskDetailReadScope(record.successor.token.scope, scope)) {
        return join(record.successor);
      }
    }

    const pending = createPending(record, scope, read);
    if (record.owner?.started && !record.owner.superseded) {
      record.owner.superseded = true;
    }
    record.owner = pending as TaskDetailPendingRead<unknown>;
    return runPending(record, pending, options?.deferPhysicalStart);
  };

  const invalidate = (key: string, resource: 'snapshot' | 'full'): void => {
    const record = ensureRecord(key, resource);
    record.sourceEpoch += 1;
    const active = record.active;
    if (!active || active.invalidated) {
      if (record.successor) {
        record.successor.token.sourceEpoch = record.sourceEpoch;
        record.successor.token.serial = ++record.latestRequestSerial;
      }
      return;
    }
    active.invalidated = true;
    if (!record.successor) {
      record.successor = createPending(record, active.pending.token.scope, active.pending.read);
      record.successor.requested = false;
    } else {
      record.successor.token.sourceEpoch = record.sourceEpoch;
      record.successor.token.serial = ++record.latestRequestSerial;
    }
  };

  return {
    readSnapshot: (teamName, scope, read, options) =>
      readResource(
        taskDetailSnapshotResourceKey(scope, options?.mode ?? 'full'),
        'snapshot',
        scope,
        read,
        options
      ),
    readFull: (identity, scope, read) =>
      readResource(taskDetailFullResourceKey(identity), 'full', scope, read),
    invalidateSnapshot: (teamName, contextId) => {
      const prefix = taskDetailSnapshotResourceKey({ contextId, teamName }).slice(0, -4);
      for (const [key, record] of records) {
        if (record.resource === 'snapshot' && key.startsWith(prefix)) {
          invalidate(key, 'snapshot');
        }
      }
      const fallbackKey = taskDetailSnapshotResourceKey({ contextId, teamName });
      if (!records.has(fallbackKey)) {
        ensureRecord(fallbackKey, 'snapshot');
        invalidate(fallbackKey, 'snapshot');
      }
    },
    invalidateFull: (identity) => invalidate(taskDetailFullResourceKey(identity), 'full'),
    isTokenCurrent: (token, scope) => {
      const record = records.get(token.key);
      return (
        record !== undefined &&
        record.sourceEpoch === token.sourceEpoch &&
        record.latestRequestSerial === token.serial &&
        (scope === undefined || isSameTaskDetailReadScope(token.scope, scope))
      );
    },
  };
}
