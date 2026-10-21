import type { BackendHandle } from './index';

export const AGENT_BACKEND_INVOKE_CHANNEL = 'agentBackend:invoke';
export const AGENT_BACKEND_OPERATIONS_ROUTE = '/api/agent-backend/operations';

export interface BackendTaskRef {
  taskId: string;
  displayId: string;
  teamName: string;
}

export interface BackendOperationPayloads {
  'task.create': {
    subject: string;
    description?: string;
    owner?: string;
    blockedBy?: string[];
    descriptionTaskRefs?: BackendTaskRef[];
  };
  'task.update': { taskId: string; subject?: string; description?: string };
  'task.assign': { taskId: string; owner: string };
  'task.lifecycle': {
    taskId: string;
    action: 'start' | 'complete' | 'delete' | 'restore' | 'pending';
  };
  'task.comment': { taskId: string; text: string; taskRefs?: BackendTaskRef[] };
  'message.send': { to: string; text: string; taskRefs?: BackendTaskRef[] };
  'task.get': { taskId: string };
  'tasks.list': Record<string, never>;
  'command.lookup': Record<string, never>;
  'runtime.open': { memberId: string };
  'runtime.read': { memberId: string };
  'runtime.dispatch': { memberId: string };
  'runtime.stop': { memberId: string };
  'runtime.interrupt': { memberId: string; inputId: string };
  'runtime.interaction': {
    memberId: string;
    inputId: string;
    interactionRef: string;
    reply:
      | { kind: 'permission'; decision: 'allow' | 'deny' }
      | { kind: 'question'; answers: Record<string, string> };
  };
  'runtime.reconcile': { memberId: string };
  'runtime.checkpoint': { memberId: string; checkpointId: string };
}

export type BackendOperation = keyof BackendOperationPayloads;
export type BackendOperationRequest = {
  [Operation in BackendOperation]: {
    readonly handle: BackendHandle;
    /** Supplied once by the caller; read operations do not persist a command receipt. */
    readonly commandId: string;
    readonly operation: Operation;
    readonly payload: BackendOperationPayloads[Operation];
  };
}[BackendOperation];

export interface BackendComment {
  id: string;
  author?: string;
  text?: string;
  createdAt?: string;
  type?: string;
  taskRefs?: BackendTaskRef[];
}

export interface BackendTask {
  id: string;
  status: string;
  subject?: string;
  description?: string;
  displayId?: string;
  owner?: string;
  blocks?: string[];
  blockedBy?: string[];
  related?: string[];
  descriptionTaskRefs?: BackendTaskRef[];
  comments?: BackendComment[];
}

export interface BackendCommandReceipt {
  commandId: string;
  phase: 'prepared' | 'applying' | 'completed' | 'rejected' | 'held';
  operation:
    | 'task.create'
    | 'task.update'
    | 'task.assign'
    | 'task.lifecycle'
    | 'task.comment'
    | 'message.send';
  task?: BackendTask;
  comment?: BackendComment;
  messageId?: string;
  deliveryId?: string;
}

export interface BackendRuntimeSnapshot {
  memberId: string;
  phase: string;
  sealed: boolean;
  custody: 'owned' | 'released' | 'unknown';
  nativeReady: boolean;
  attached: boolean;
  inputs: { inputId: string; phase: string; terminal?: 'succeeded' | 'failed' | 'cancelled' }[];
  interactions: {
    interactionRef: string;
    inputId: string;
    kind: 'permission' | 'question';
    expiresAt: number;
    phase: string;
  }[];
  diagnostic?: string;
}

export interface BackendCheckpoint {
  checkpointId: string;
  status: 'published' | 'unsupported' | 'held';
  reference?: string;
}

export type BackendOperationResult =
  | {
      ok: true;
      value:
        | BackendTask
        | BackendTask[]
        | BackendCommandReceipt
        | BackendRuntimeSnapshot
        | BackendCheckpoint
        | null;
    }
  | {
      ok: false;
      code:
        | 'invalid'
        | 'conflict'
        | 'forbidden'
        | 'hold'
        | 'busy'
        | 'unavailable'
        | 'shutting-down';
      outcome: 'not-dispatched' | 'rejected' | 'unknown';
    };

export interface AgentBackendApi {
  invoke(request: BackendOperationRequest): Promise<BackendOperationResult>;
}

/** App API fragment shared by Electron preload and the HTTP-backed app client. */
export interface AgentBackendElectronApi {
  agentBackend: AgentBackendApi;
}
