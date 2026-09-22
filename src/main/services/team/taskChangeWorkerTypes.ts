import type { TaskChangeSetV2 } from '@shared/types';

export interface TaskChangeTaskMeta {
  displayId?: string;
  createdAt?: string;
  owner?: string;
  status?: string;
  intervals?: { startedAt: string; completedAt?: string }[];
  reviewState?: 'review' | 'needsFix' | 'approved' | 'none';
  historyEvents?: unknown[];
  kanbanColumn?: 'review' | 'approved';
}

export interface TaskChangeEffectiveOptions {
  owner?: string;
  status?: string;
  intervals?: { startedAt: string; completedAt?: string }[];
  since?: string;
}

export interface ResolvedTaskChangeComputeInput {
  teamName: string;
  taskId: string;
  taskMeta: TaskChangeTaskMeta | null;
  effectiveOptions: TaskChangeEffectiveOptions;
  projectPath?: string;
  includeDetails: boolean;
}

export interface ComputeTaskChangesRequest {
  id: string;
  op: 'computeTaskChanges';
  payload: ResolvedTaskChangeComputeInput;
}

export interface ComputeTaskChangesSuccessResponse {
  id: string;
  ok: true;
  result: TaskChangeSetV2;
}

export interface ComputeTaskChangesErrorResponse {
  id: string;
  ok: false;
  error: string;
}

export type TaskChangeWorkerRequest = ComputeTaskChangesRequest;
export type TaskChangeWorkerResponse =
  | ComputeTaskChangesSuccessResponse
  | ComputeTaskChangesErrorResponse;
