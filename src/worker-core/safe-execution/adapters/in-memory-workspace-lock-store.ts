import type {
  TaskRunId,
  WorkspaceLockHandle,
  WorkspaceLockRecord,
} from "../domain/safe-execution-task";
import type { WorkspaceLockStore } from "../ports/safe-execution-ports";
import {
  canReplaceLock,
  workspaceLockedError,
  workspaceLockKey,
} from "./workspace-locking";

export class InMemoryWorkspaceLockStore implements WorkspaceLockStore {
  private readonly locks = new Map<string, WorkspaceLockRecord>();

  async acquire(input: {
    readonly taskId: TaskRunId;
    readonly workspacePath: string;
    readonly ownerId: string;
    readonly ownerPid?: number;
    readonly staleLockMs?: number;
    readonly now?: Date;
  }): Promise<WorkspaceLockHandle> {
    const workspacePath = input.workspacePath;
    const key = workspaceLockKey(workspacePath);
    const now = input.now ?? new Date();
    const existing = this.locks.get(key);
    if (existing && !canReplaceLock(existing, now)) {
      throw workspaceLockedError(existing);
    }
    const record: WorkspaceLockRecord = {
      taskId: input.taskId,
      workspacePath,
      ownerId: input.ownerId,
      ...(input.ownerPid === undefined ? {} : { ownerPid: input.ownerPid }),
      acquiredAt: now,
      ...(input.staleLockMs === undefined ? {} : { staleLockMs: input.staleLockMs }),
    };
    this.locks.set(key, record);
    return {
      ...record,
      release: async () => {
        const current = this.locks.get(key);
        if (current?.ownerId === record.ownerId && current.taskId === record.taskId) {
          this.locks.delete(key);
        }
      },
    };
  }
}
