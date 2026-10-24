import type { AttachmentReference } from '../attachments/uploadContracts.js';
import type { CapturedCrossTeamIntent } from '../cross-team/contracts.js';
import type { JsonValue } from '../contracts.js';
export type {
  ReplaceTeamRoster,
  TeamRosterConfiguration,
  TeamRosterReceipt,
  TeamMemberSettings,
  TeamSavedSettings,
} from './rosterContracts.js';

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
  settings?: import('./rosterContracts.js').TeamMemberSettings | undefined;
}

export interface TeamGrant {
  principalId: string;
  memberName: string;
  permissions: ('read' | 'task.write' | 'message.write' | 'process.write' | 'admin')[];
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
        related?: string[];
        prompt?: string;
        promptTaskRefs?: TaskRef[];
        startImmediately?: boolean;
        descriptionTaskRefs?: TaskRef[];
      };
    }
  | {
      operation: 'task.update';
      payload: { taskId: string; subject?: string; description?: string };
    }
  | {
      operation: 'task.board.clear';
      payload: { taskId: string };
    }
  | {
      operation: 'task.board.order';
      payload: {
        columnId: 'todo' | 'in_progress' | 'done' | 'review' | 'approved';
        orderedTaskIds: string[];
      };
    }
  | {
      operation: 'task.relationship';
      payload: {
        taskId: string;
        targetId: string;
        type: 'blockedBy' | 'blocks' | 'related';
        action: 'add' | 'remove';
      };
    }
  | {
      operation: 'task.clarification';
      payload: { taskId: string; value: 'lead' | 'user' | null };
    }
  | {
      operation: 'task.attachment.add';
      payload: { taskId: string; attachment: AttachmentReference };
    }
  | { operation: 'task.attachment.remove'; payload: { taskId: string; attachmentId: string } }
  | { operation: 'task.start'; payload: { taskId: string; notification: 'legacy' | 'user' } }
  | { operation: 'task.assign'; payload: { taskId: string; owner: string | null } }
  | {
      operation: 'task.lifecycle';
      payload: {
        taskId: string;
        action: 'start' | 'complete' | 'delete' | 'restore' | 'pending';
      };
    }
  | {
      operation: 'task.review';
      payload:
        | { taskId: string; action: 'request'; reviewer?: string }
        | { taskId: string; action: 'start' }
        | { taskId: string; action: 'disapprove' }
        | {
            taskId: string;
            action: 'approve';
            note?: string;
            notifyOwner?: boolean;
            suppressTaskComment?: boolean;
          }
        | { taskId: string; action: 'request_changes'; comment: string; taskRefs?: TaskRef[] };
    }
  | {
      operation: 'task.comment';
      payload: {
        taskId: string;
        text: string;
        taskRefs?: TaskRef[];
        attachments?: AttachmentReference[];
      };
    }
  | {
      operation: 'message.send';
      payload: {
        to: string;
        text: string;
        taskRefs?: TaskRef[];
        messageId?: string;
        summary?: string;
        actionMode?: 'do' | 'ask' | 'delegate';
        attachments?: readonly AttachmentReference[];
      };
    }
);

export interface PreparedEffects {
  taskId: string;
  commentId: string;
  messageId: string;
  deliveryId: string;
}

export interface CommandReceipt {
  /** Private Host pair admission; ordinary commands never accept this field. */
  crossTeam?: CapturedCrossTeamIntent;
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
  /** Captured for immutable rich native content; renderer cannot select or change this role. */
  messageRecipientRole?: 'lead' | 'member';
  authorityRevision?: number;
  /** New Task publication never changes product bytes before its durable file plan exists. */
  taskPlanVersion?: 1;
  taskPreimage?: string;
  /** Captured before canonical planning; recovery never resolves old notifications to a new run. */
  taskStartLeadName?: string;
  taskRecipients?: { name: string; delivery?: DeliveryBinding }[];
}

export type RuntimeMemberBinding = Omit<DeliveryBinding, 'teamName'>;

export interface ImmutableDelivery {
  binding: RuntimeMemberBinding;
  deliveryId: string;
  inputId: string;
  messageId: string;
  content: string;
  attachments?: readonly AttachmentReference[];
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
  attachments?: readonly AttachmentReference[];
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
  /** Optional existing Runtime cancellation capability, used for Task notification retraction. */
  cancelDelivery?(intent: DeliveryIntent): Promise<DeliveryAdmission>;
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
