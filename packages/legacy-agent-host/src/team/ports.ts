import type { JsonValue } from '../contracts.js';

export interface TeamTask {
  id: string;
  status: string;
  [key: string]: JsonValue | undefined;
}

/** Canonical taskBoard policy, implemented by the existing portable controller. */
export interface TaskBoardPolicy {
  createTask(input: Record<string, unknown>): TeamTask;
  getTask(id: string): TeamTask;
  listTasks(): TeamTask[];
  listDeletedTasks(): TeamTask[];
  updateTaskFields(id: string, fields: Record<string, unknown>): TeamTask;
  setTaskOwner(id: string, owner: string, actor: string): TeamTask;
  startTask(id: string, actor: string): TeamTask;
  completeTask(id: string, actor: string): TeamTask;
  softDeleteTask(id: string, actor: string): TeamTask;
  restoreTask(id: string, actor: string): TeamTask;
  setTaskStatus(id: string, status: string, actor: string): TeamTask;
  addTaskComment(id: string, flags: Record<string, unknown>): unknown;
}

export interface TeamPolicyPort {
  taskBoard(actor?: string): TaskBoardPolicy;
  sendMessage(
    actor: string,
    flags: Record<string, unknown>
  ): { messageId: string; message: JsonValue };
  readInbox(member: string): JsonValue[];
}

/** Storage transitions and current authority use the same synchronous resource fence. */
export interface TeamStore {
  fenced<T>(action: () => T): T;
  read<T>(name: string): T | undefined;
  write(name: string, value: unknown): void;
  list<T>(directory: string): T[];
  productFingerprint(teamName: string): string;
}
