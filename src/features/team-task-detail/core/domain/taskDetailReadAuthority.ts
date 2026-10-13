import type { TaskDetailIdentity } from '../../contracts';

export interface TaskDetailReadScope {
  contextId: string;
  teamName: string;
  contextEpoch: number;
  teamStateEpoch: number;
}

export interface TaskDetailReadToken {
  resource: 'snapshot' | 'full';
  key: string;
  sourceEpoch: number;
  /** Starts are globally ordered so compact/full projections can be provenanced. */
  serial: number;
  scope: TaskDetailReadScope;
}

export interface TaskDetailReadResult<T> {
  token: TaskDetailReadToken;
  value?: T;
  error?: unknown;
}

export interface TaskDetailReadHandle<T> {
  token: TaskDetailReadToken;
  result: Promise<TaskDetailReadResult<T>>;
}

interface TaskDetailReadRecord<T> {
  key: string;
  sourceEpoch: number;
  latestStartedSerial: number;
  active: TaskDetailActiveRead<T> | null;
  successor: TaskDetailPendingSuccessor<T> | null;
}

interface TaskDetailActiveRead<T> {
  token: TaskDetailReadToken;
  handle: TaskDetailReadHandle<T>;
  invalidated: boolean;
  read: (token: TaskDetailReadToken) => Promise<T>;
}

interface TaskDetailPendingSuccessor<T> {
  token: TaskDetailReadToken;
  handle: TaskDetailReadHandle<T>;
  resolveResult: (result: TaskDetailReadResult<T>) => void;
  read: (token: TaskDetailReadToken) => Promise<T>;
}

export interface TaskDetailReadAuthority {
  readSnapshot<T>(
    teamName: string,
    scope: TaskDetailReadScope,
    read: (token: TaskDetailReadToken) => Promise<T>,
    options?: { forceNew?: boolean }
  ): TaskDetailReadHandle<T>;
  readFull<T>(
    identity: TaskDetailIdentity,
    scope: TaskDetailReadScope,
    read: (token: TaskDetailReadToken) => Promise<T>
  ): TaskDetailReadHandle<T>;
  invalidateSnapshot(teamName: string, contextId: string): void;
  invalidateFull(identity: TaskDetailIdentity): void;
  isTokenCurrent(token: TaskDetailReadToken, scope?: TaskDetailReadScope): boolean;
}

function snapshotKey(scope: Pick<TaskDetailReadScope, 'contextId' | 'teamName'>): string {
  return `snapshot:${JSON.stringify([scope.contextId, scope.teamName])}`;
}

function fullKey(identity: TaskDetailIdentity): string {
  return `full:${JSON.stringify([identity.contextId, identity.teamName, identity.taskId])}`;
}

function sameScope(left: TaskDetailReadScope, right: TaskDetailReadScope): boolean {
  return (
    left.contextId === right.contextId &&
    left.teamName === right.teamName &&
    left.contextEpoch === right.contextEpoch &&
    left.teamStateEpoch === right.teamStateEpoch
  );
}

/**
 * Focused physical-read authority for the two task-detail resources. It has no
 * queue, cache, or ref-count policy: joins reuse the current physical request,
 * while invalidation creates at most one same-resource successor after settle.
 */
export function createTaskDetailReadAuthority(): TaskDetailReadAuthority {
  const records = new Map<string, TaskDetailReadRecord<unknown>>();
  let latestGlobalStartSerial = 0;

  const ensureRecord = (key: string): TaskDetailReadRecord<unknown> => {
    let record = records.get(key);
    if (!record) {
      record = { key, sourceEpoch: 1, latestStartedSerial: 0, active: null, successor: null };
      records.set(key, record);
    }
    return record;
  };

  const isTokenCurrent = (token: TaskDetailReadToken, scope?: TaskDetailReadScope): boolean => {
    const record = records.get(token.key);
    return (
      record !== undefined &&
      record.sourceEpoch === token.sourceEpoch &&
      record.latestStartedSerial === token.serial &&
      (scope === undefined || sameScope(token.scope, scope))
    );
  };

  const createSuccessor = <T>(
    record: TaskDetailReadRecord<unknown>,
    scope: TaskDetailReadScope,
    read: (token: TaskDetailReadToken) => Promise<T>
  ): TaskDetailPendingSuccessor<T> => {
    const token: TaskDetailReadToken = {
      resource: record.key.startsWith('snapshot:') ? 'snapshot' : 'full',
      key: record.key,
      sourceEpoch: record.sourceEpoch,
      serial: (record.latestStartedSerial = ++latestGlobalStartSerial),
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
    };
  };

  const runRead = <T>(
    record: TaskDetailReadRecord<unknown>,
    pending: TaskDetailPendingSuccessor<T>
  ): TaskDetailReadHandle<T> => {
    const { token, handle, resolveResult, read } = pending;
    const active: TaskDetailActiveRead<T> = { token, handle, invalidated: false, read };
    record.active = active as TaskDetailActiveRead<unknown>;

    void (async () => {
      try {
        const value = await read(token);
        resolveResult({ token, value });
      } catch (error) {
        resolveResult({ token, error });
      } finally {
        if (record.active === (active as TaskDetailActiveRead<unknown>)) {
          record.active = null;
          const successor = record.successor;
          record.successor = null;
          if (active.invalidated && successor) {
            void runRead(record, successor as TaskDetailPendingSuccessor<unknown>);
          }
        }
      }
    })();
    return handle;
  };

  const startRead = <T>(
    record: TaskDetailReadRecord<unknown>,
    scope: TaskDetailReadScope,
    read: (token: TaskDetailReadToken) => Promise<T>
  ): TaskDetailReadHandle<T> =>
    runRead(record, createSuccessor(record, scope, read) as TaskDetailPendingSuccessor<T>);

  const readResource = <T>(
    key: string,
    scope: TaskDetailReadScope,
    read: (token: TaskDetailReadToken) => Promise<T>,
    forceNew = false
  ): TaskDetailReadHandle<T> => {
    const record = ensureRecord(key);
    if (!forceNew && record.active && !record.active.invalidated) {
      if (!sameScope(record.active.token.scope, scope)) {
        return startRead(record, scope, read);
      }
      return record.active.handle as TaskDetailReadHandle<T>;
    }
    if (!forceNew && record.active?.invalidated && record.successor) {
      if (!sameScope(record.successor.token.scope, scope)) {
        return startRead(record, scope, read);
      }
      return record.successor.handle as TaskDetailReadHandle<T>;
    }
    return startRead(record as TaskDetailReadRecord<unknown>, scope, read);
  };

  const invalidate = (key: string): void => {
    const record = records.get(key);
    if (!record) return;
    const active = record.active;
    if (!active || active.invalidated) return;
    record.sourceEpoch += 1;
    active.invalidated = true;
    record.successor = createSuccessor(record, active.token.scope, active.read);
  };

  return {
    readSnapshot: (teamName, scope, read, options) =>
      readResource(
        snapshotKey({ contextId: scope.contextId, teamName }),
        scope,
        read,
        options?.forceNew === true
      ),
    readFull: (identity, scope, read) => readResource(fullKey(identity), scope, read),
    invalidateSnapshot: (teamName, contextId) => invalidate(snapshotKey({ contextId, teamName })),
    invalidateFull: (identity) => invalidate(fullKey(identity)),
    isTokenCurrent,
  };
}
