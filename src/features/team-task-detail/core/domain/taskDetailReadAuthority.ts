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
  successor: TaskDetailReadHandle<T> | null;
}

interface TaskDetailActiveRead<T> {
  token: TaskDetailReadToken;
  handle: TaskDetailReadHandle<T>;
  invalidated: boolean;
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
  invalidateSnapshot(teamName: string): void;
  invalidateFull(identity: TaskDetailIdentity): void;
  isTokenCurrent(token: TaskDetailReadToken, scope?: TaskDetailReadScope): boolean;
}

function snapshotKey(teamName: string): string {
  return `snapshot:${teamName}`;
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

  const startRead = <T>(
    record: TaskDetailReadRecord<unknown>,
    scope: TaskDetailReadScope,
    read: (token: TaskDetailReadToken) => Promise<T>
  ): TaskDetailReadHandle<T> => {
    const token: TaskDetailReadToken = {
      resource: record.key.startsWith('snapshot:') ? 'snapshot' : 'full',
      key: record.key,
      sourceEpoch: record.sourceEpoch,
      serial: ++record.latestStartedSerial,
      scope,
    };
    let resolveResult!: (result: TaskDetailReadResult<T>) => void;
    const result = new Promise<TaskDetailReadResult<T>>((resolve) => {
      resolveResult = resolve;
    });
    const handle = { token, result };
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
          if (!active.invalidated) record.active = null;
          if (active.invalidated && record.successor) record.successor = null;
        }
      }
    })();
    return handle;
  };

  const readResource = <T>(
    key: string,
    scope: TaskDetailReadScope,
    read: (token: TaskDetailReadToken) => Promise<T>,
    forceNew = false
  ): TaskDetailReadHandle<T> => {
    const record = ensureRecord(key);
    if (!forceNew && record.active && !record.active.invalidated) {
      return record.active.handle as TaskDetailReadHandle<T>;
    }
    if (!forceNew && record.active?.invalidated && record.successor) {
      return record.successor as TaskDetailReadHandle<T>;
    }
    return startRead(record as TaskDetailReadRecord<unknown>, scope, read);
  };

  const invalidate = (key: string): void => {
    const record = records.get(key);
    if (!record) return;
    record.sourceEpoch += 1;
    const active = record.active;
    if (!active || active.invalidated) return;
    active.invalidated = true;
    record.successor = startRead(record, active.token.scope, active.read);
  };

  return {
    readSnapshot: (teamName, scope, read, options) =>
      readResource(snapshotKey(teamName), scope, read, options?.forceNew === true),
    readFull: (identity, scope, read) => readResource(fullKey(identity), scope, read),
    invalidateSnapshot: (teamName) => invalidate(snapshotKey(teamName)),
    invalidateFull: (identity) => invalidate(fullKey(identity)),
    isTokenCurrent,
  };
}
