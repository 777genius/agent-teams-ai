import type { AttachmentReference, AttachmentUpload } from '../attachments/uploadContracts.js';
import type { AttachmentMetadata } from '../attachments/contracts.js';
import type { JsonValue } from '../contracts.js';
import type { CommandReceipt, RuntimeMemberBinding } from './contracts.js';

/** Private launch-owned technical selection; Team retains business membership/grants. */
export interface TeamRuntimeSelection {
  binding: RuntimeMemberBinding;
  /** Launch-owned original transition/skip suspends new work; cleanup remains permitted. */
  workAllowed?: boolean;
  skipped?: boolean;
  generation: number;
  configurationDigest: string;
  baseConfigurationDigest: string;
  /** Private admitted launch options, without credentials or native process selectors. */
  configuration?: JsonValue;
  restore?: { commandId: string; reference: string; sourceBinding: RuntimeMemberBinding };
}
export interface TeamRuntimeBindings {
  current(initial: RuntimeMemberBinding): TeamRuntimeSelection | undefined;
  retained(initial: RuntimeMemberBinding, binding: RuntimeMemberBinding): boolean;
}

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
  getKanbanState(options?: { strict?: boolean }): unknown;
  clearKanban(id: string): unknown;
  updateColumnOrder(columnId: string, orderedTaskIds: string[]): unknown;
  linkTask(id: string, targetId: string, type: 'blocked-by' | 'blocks' | 'related'): TeamTask;
  unlinkTask(id: string, targetId: string, type: 'blocked-by' | 'blocks' | 'related'): TeamTask;
  setNeedsClarification(id: string, value: 'lead' | 'user' | null): TeamTask;
  updateTaskFields(id: string, fields: Record<string, unknown>): TeamTask;
  setTaskOwner(id: string, owner: string | null, actor: string): TeamTask;
  startTask(id: string, actor: string): TeamTask;
  startTaskNotifying(input: {
    taskId: string;
    notification: 'legacy' | 'user';
    /** Canonical create already computed in_progress; only its notification remains. */
    created?: boolean;
    leadName?: string;
    messageId: string;
    timestamp: string;
    recipients: string[];
  }): { task: TeamTask; notifiedOwner: boolean };
  requestReview(id: string, flags: { from: string; reviewer?: string }): TeamTask;
  startReview(id: string, flags: { from: string }): unknown;
  disapproveReview(id: string, flags: { from: string }): TeamTask;
  approveReview(
    id: string,
    flags: { from: string; note?: string; 'notify-owner'?: boolean; suppressTaskComment?: boolean }
  ): unknown;
  requestChanges(
    id: string,
    flags: { from: string; comment: string; taskRefs?: import('./contracts.js').TaskRef[] }
  ): TeamTask;
  completeTask(id: string, actor: string): TeamTask;
  softDeleteTask(id: string, actor: string): TeamTask;
  restoreTask(id: string, actor: string): TeamTask;
  setTaskStatus(id: string, status: string, actor: string): TeamTask;
  addTaskComment(id: string, flags: Record<string, unknown>): unknown;
  addTaskAttachmentMeta?(id: string, meta: Record<string, unknown>): TeamTask;
  removeTaskAttachment?(id: string, attachmentId: string): TeamTask;
}

/** Existing portable board query policy; the owner supplies all authority. */
export interface TeamBoardReadPolicy {
  getTaskComment(taskId: string, commentId: string): unknown;
  listTaskInventory(filters: TeamTaskInventoryFilters): unknown;
  taskBriefing(memberName: string): Promise<string>;
  leadBriefing(): Promise<string>;
  memberBriefing?(
    memberName: string,
    options: { includeActiveProcesses: boolean }
  ): Promise<string>;
  getKanbanState(options?: { strict?: boolean }): unknown;
  listReviewers(): unknown;
}
export interface TeamTaskInventoryFilters {
  owner?: string;
  status?: 'pending' | 'in_progress' | 'completed';
  reviewState?: 'none' | 'review' | 'needsFix' | 'approved';
  kanbanColumn?: 'review' | 'approved';
  relatedTo?: string;
  blockedBy?: string;
  limit?: number;
}

export interface TeamPolicyPort {
  attachments?: TeamAttachmentPort;
  /** Optional only for product-only/test policies without a portable read adapter. */
  reads?: TeamBoardReadPolicy;
  processes?: import('../process/TeamProcessCommands.js').ProcessRegistryPolicy;
  taskBoard(actor?: string): TaskBoardPolicy;
  sendMessage(
    actor: string,
    flags: Record<string, unknown>
  ): { messageId: string; message: JsonValue };
  readInbox(member: string): JsonValue[];
  /** Trusted paired-source provenance has already been verified by TeamOwner. */
  sendGroupMessage?(flags: Record<string, unknown>): { messageId: string; message: JsonValue };
  sendCrossTeamMessage?(flags: Record<string, unknown>): { messageId: string; message: JsonValue };
  readSentMessages?(): JsonValue[];
  appendSentMessage?(flags: Record<string, unknown>): JsonValue;
}

export interface TaskNotification {
  member: string;
  messageId: string;
  content: string;
}

export interface PreparedTaskMutation {
  result: JsonValue;
  taskHash: string;
  notifications: TaskNotification[];
  removedMessageIds: string[];
}

export class TaskPolicyRejected extends Error {}

/** Task-only canonical policy preparation and exact file publication, within Team's fence. */
export interface TaskMutationPort {
  load(receipt: CommandReceipt): PreparedTaskMutation | undefined;
  prepare(
    receipt: CommandReceipt,
    actor: string,
    apply: (board: TaskBoardPolicy) => JsonValue
  ): PreparedTaskMutation;
  validate(receipt: CommandReceipt): void;
  publish(receipt: CommandReceipt): void;
}

/** Storage transitions and current authority use the same synchronous resource fence. */
export interface TeamStore {
  /** Private bounded command-result artifact, never an arbitrary filesystem selector. */
  readCommandResult?(reference: { sha256: string; sizeBytes: number }): unknown;
  fenced<T>(action: () => T): T;
  read<T>(name: string): T | undefined;
  write(name: string, value: unknown): void;
  list<T>(directory: string): T[];
  productFingerprint(teamName: string): string;
}

/** Product policy receives verified owner metadata; native bytes remain private. */
export interface TeamAttachmentPort {
  metadata(
    refs: readonly AttachmentReference[],
    purpose?: AttachmentUpload['purpose']
  ): AttachmentMetadata[];
}
