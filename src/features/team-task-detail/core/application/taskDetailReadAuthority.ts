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
  current: TaskDetailPendingRead<unknown> | null;
  latestStartedToken: TaskDetailReadToken | null;
  active: Set<TaskDetailPendingRead<unknown>>;
  successor: TaskDetailPendingRead<unknown> | null;
}

interface TaskDetailPendingRead<T> {
  token: TaskDetailReadToken;
  handle: TaskDetailReadHandle<T>;
  resolveResult: (result: TaskDetailReadResult<T>) => void;
  read: ReadCallback<T>;
  requested: boolean;
  started: boolean;
  settled: boolean;
  superseded: boolean;
}

interface PhysicalStartProvenance {
  order: number;
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
  resetForTests(): void;
}

export function createTaskDetailReadAuthority(): TaskDetailReadAuthority {
  const records = new Map<string, TaskDetailReadRecord>();
  const physicalProvenanceByPromise = new WeakMap<Promise<unknown>, PhysicalStartProvenance>();
  let latestPhysicalStartOrder = 0;

  const ensureRecord = (key: string, resource: 'snapshot' | 'full'): TaskDetailReadRecord => {
    let record = records.get(key);
    if (!record) {
      record = {
        key,
        resource,
        sourceEpoch: 1,
        latestRequestSerial: 0,
        current: null,
        latestStartedToken: null,
        active: new Set(),
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
      settled: false,
      superseded: false,
    };
  };

  const resolvePending = <T>(
    pending: TaskDetailPendingRead<T>,
    result: TaskDetailReadResult<T>
  ): void => {
    if (pending.settled) return;
    pending.settled = true;
    pending.resolveResult(result);
  };

  const startPending = <T>(
    record: TaskDetailReadRecord,
    pending: TaskDetailPendingRead<T>,
    deferPhysicalStart: boolean
  ): TaskDetailReadHandle<T> => {
    if (pending.started || pending.settled) return pending.handle;
    pending.started = true;
    record.latestStartedToken = pending.token;
    record.active.add(pending as TaskDetailPendingRead<unknown>);
    let provenance: PhysicalStartProvenance | null = null;
    const markPhysicalStart = (): void => {
      if (!provenance) provenance = { order: ++latestPhysicalStartOrder };
      pending.token.physicalStartOrder = provenance.order;
    };
    if (!deferPhysicalStart) markPhysicalStart();

    void (async () => {
      try {
        const readPromise = pending.read(pending.token, markPhysicalStart);
        const sharedProvenance = physicalProvenanceByPromise.get(readPromise);
        if (sharedProvenance) {
          provenance = sharedProvenance;
          pending.token.physicalStartOrder = sharedProvenance.order;
        } else if (provenance) {
          physicalProvenanceByPromise.set(readPromise, provenance);
        }
        const value = await readPromise;
        resolvePending(pending, { token: pending.token, value });
      } catch (error) {
        resolvePending(pending, { token: pending.token, error });
      } finally {
        record.active.delete(pending as TaskDetailPendingRead<unknown>);
        if (record.current === (pending as TaskDetailPendingRead<unknown>) && !pending.superseded) {
          const successor = record.successor;
          if (successor?.requested && !successor.superseded) {
            record.current = successor as TaskDetailPendingRead<unknown>;
            record.successor = null;
            void startPending(record, successor as TaskDetailPendingRead<unknown>, false);
          } else {
            record.current = null;
            record.successor = null;
          }
        } else if (record.successor?.superseded) {
          record.successor = null;
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

    if (
      !options?.forceNew &&
      record.current &&
      !record.current.superseded &&
      !record.current.settled
    ) {
      const currentIsEligible =
        record.current.token.sourceEpoch === record.sourceEpoch &&
        isSameTaskDetailReadScope(record.current.token.scope, scope);
      if (currentIsEligible && record.current.started && record.active.has(record.current)) {
        return join(record.current);
      }
    }
    if (
      !options?.forceNew &&
      record.successor &&
      !record.successor.superseded &&
      !record.successor.settled
    ) {
      if (
        record.successor.token.sourceEpoch === record.sourceEpoch &&
        isSameTaskDetailReadScope(record.successor.token.scope, scope)
      ) {
        return join(record.successor);
      }
    }

    const pending = createPending(record, scope, read);
    const obsoleteCurrent = record.current;
    const obsoleteSuccessor = record.successor;
    if (obsoleteCurrent && !obsoleteCurrent.settled) obsoleteCurrent.superseded = true;
    if (obsoleteSuccessor && !obsoleteSuccessor.settled) {
      obsoleteSuccessor.superseded = true;
      resolvePending(obsoleteSuccessor, {
        token: obsoleteSuccessor.token,
        error: new Error('task detail read superseded'),
      });
    }
    record.successor = null;
    record.current = pending as TaskDetailPendingRead<unknown>;
    return runPending(record, pending, options?.deferPhysicalStart);
  };

  const invalidate = (key: string, resource: 'snapshot' | 'full'): void => {
    const record = ensureRecord(key, resource);
    record.sourceEpoch += 1;
    const current = record.current;
    if (!current || current.settled || current.superseded || !record.active.has(current)) return;
    if (!record.successor) {
      record.successor = createPending(record, current.token.scope, current.read);
      record.successor.requested = false;
    }
    record.successor.token.sourceEpoch = record.sourceEpoch;
    record.successor.token.serial = ++record.latestRequestSerial;
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
        record.latestStartedToken === token &&
        token.physicalStartOrder > 0 &&
        (scope === undefined || isSameTaskDetailReadScope(token.scope, scope))
      );
    },
    resetForTests: () => {
      records.clear();
      latestPhysicalStartOrder = 0;
    },
  };
}
