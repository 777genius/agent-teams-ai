import type { JsonValue } from '../contracts.js';

export interface TeamBinding {
  backendId: string;
  teamId: string;
  teamName: string;
}

export interface DeliveryBinding extends TeamBinding {
  runId: string;
  memberId: string;
  generation: string;
}

export interface TeamMember {
  memberId: string;
  name: string;
  role: 'lead' | 'member';
  /** Supplied by trusted composition, never inferred from a display name. */
  delivery?: DeliveryBinding;
}

export interface TeamGrant {
  principalId: string;
  memberName: string;
  permissions: ('read' | 'task.write' | 'message.write' | 'admin')[];
  revoked?: boolean;
  /** Monotonic for this captured principal; unrelated grants do not invalidate its intents. */
  revision?: number;
}

export interface TaskRef {
  taskId: string;
  displayId: string;
  teamName: string;
}

export type TeamCommand = { commandId: string } & (
  | {
      operation: 'task.create';
      payload: {
        subject: string;
        description?: string;
        owner?: string;
        blockedBy?: string[];
        descriptionTaskRefs?: TaskRef[];
      };
    }
  | {
      operation: 'task.update';
      payload: { taskId: string; subject?: string; description?: string };
    }
  | { operation: 'task.assign'; payload: { taskId: string; owner: string } }
  | {
      operation: 'task.lifecycle';
      payload: {
        taskId: string;
        action: 'start' | 'complete' | 'delete' | 'restore' | 'pending';
      };
    }
  | { operation: 'task.comment'; payload: { taskId: string; text: string; taskRefs?: TaskRef[] } }
  | { operation: 'message.send'; payload: { to: string; text: string; taskRefs?: TaskRef[] } }
);

export interface PreparedEffects {
  taskId: string;
  commentId: string;
  messageId: string;
  deliveryId: string;
}

export interface CommandReceipt {
  schemaVersion: 1;
  binding: TeamBinding;
  commandId: string;
  principalId: string;
  fingerprint: string;
  command: TeamCommand;
  effects: PreparedEffects;
  createdAt: string;
  phase: 'prepared' | 'applying' | 'completed' | 'rejected' | 'held';
  result?: JsonValue;
  /** Product hash after the canonical use case; a mismatch blocks stale backup restore. */
  taskHash?: string;
  deliveryBinding?: DeliveryBinding;
  authorityRevision?: number;
}

export type RuntimeMemberBinding = Omit<DeliveryBinding, 'teamName'>;

export interface ImmutableDelivery {
  binding: RuntimeMemberBinding;
  deliveryId: string;
  inputId: string;
  messageId: string;
  content: string;
}

export interface DeliveryIntent {
  schemaVersion: 1;
  binding: DeliveryBinding;
  commandId: string;
  principalId: string;
  messageId: string;
  deliveryId: string;
  inputId: string;
  content: string;
  authorityRevision: number;
  phase: 'pending' | 'admitted' | 'not_admitted';
  runtimeReceipt?: JsonValue;
}

export interface DeliveryAdmission {
  inputId: string;
  outcome: 'admitted' | 'not_admitted' | 'unknown';
  receipt?: JsonValue;
}

/** Runtime owns durable admission and native handoff. Neither method submits in Team. */
export interface TeamRuntimeDeliveryPort {
  admitDelivery(intent: DeliveryIntent): Promise<DeliveryAdmission>;
  lookupDelivery(intent: DeliveryIntent): Promise<DeliveryAdmission>;
  /** Official Runtime proof fingerprint, shared by its persisted input and admission receipt. */
  fingerprintDelivery(intent: ImmutableDelivery): string;
}

export interface DeliveryResumeResult {
  deliveryId: string;
  outcome: 'admitted' | 'not_admitted' | 'pending' | 'held';
}

export type TeamOwnerErrorCode = 'invalid' | 'conflict' | 'forbidden' | 'hold';

export class TeamOwnerError extends Error {
  constructor(readonly code: TeamOwnerErrorCode) {
    super(`Team operation ${code}`);
  }
}
