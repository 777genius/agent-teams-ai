import { parseReviewOriginScope } from '@agent-teams/task-change-ledger/review-transport';

import {
  AGENT_BACKEND_REVIEW_UNWATCH_CHANNEL,
  AGENT_BACKEND_REVIEW_WATCH_CHANNEL,
} from '../../../contracts/reviewWatch';

import { createReviewWatchAdmissionOrder } from './createReviewWatchAdmissionOrder';

import type {
  BackendReviewUnwatchRequest,
  BackendReviewWatchRequest,
} from '../../../contracts/reviewWatch';
import type { BackendRequestGuard } from '../../application/backendBinding';
import type { CapturedReviewWatch } from './CapturedReviewWatch';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

export function readCapturedReviewUnwatchRequest(value: unknown): BackendReviewUnwatchRequest {
  if (
    !value ||
    typeof value !== 'object' ||
    !('handle' in value) ||
    !value.handle ||
    typeof value.handle !== 'object' ||
    !('handleId' in value.handle) ||
    typeof value.handle.handleId !== 'string' ||
    !('watchId' in value) ||
    typeof value.watchId !== 'string'
  ) {
    throw new Error('Invalid captured review watch identity');
  }
  return { handle: { handleId: value.handle.handleId }, watchId: value.watchId };
}

export function readCapturedReviewWatchRequest(value: unknown): BackendReviewWatchRequest {
  const captured = readCapturedReviewUnwatchRequest(value);
  if (
    !value ||
    typeof value !== 'object' ||
    !('projectPath' in value) ||
    typeof value.projectPath !== 'string' ||
    !('filePaths' in value) ||
    !Array.isArray(value.filePaths) ||
    !value.filePaths.every((path): path is string => typeof path === 'string')
  ) {
    throw new Error('Invalid captured review watch paths');
  }
  return {
    ...captured,
    projectPath: value.projectPath,
    filePaths: [...value.filePaths],
    ...('scope' in value && value.scope !== undefined
      ? { scope: parseReviewOriginScope(value.scope) }
      : {}),
  };
}

export interface CapturedReviewWatchAdmission {
  bridge: CapturedReviewWatch;
  guard: BackendRequestGuard;
}

export interface CapturedReviewWatchIpcAuthorization {
  captureWatch(
    event: IpcMainInvokeEvent,
    request: BackendReviewWatchRequest
  ): Promise<CapturedReviewWatchAdmission | null>;
  /** Synchronous sender/mainFrame validation; exact cleanup may outlive its context epoch. */
  captureCleanup(event: IpcMainInvokeEvent): { owner: object; bridge?: CapturedReviewWatch } | null;
}

export function registerCapturedReviewWatchIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  authorization: CapturedReviewWatchIpcAuthorization
): () => void {
  const order = createReviewWatchAdmissionOrder();
  ipc.handle(AGENT_BACKEND_REVIEW_WATCH_CHANNEL, async (event, value: unknown) => {
    const request = readCapturedReviewWatchRequest(value);
    const sender = authorization.captureCleanup(event);
    if (!sender) throw new Error('Captured review watch sender unavailable');
    const admission = order.begin(sender.owner, request);
    try {
      const captured = await authorization.captureWatch(event, request);
      if (!admission.isCurrent()) return;
      if (!captured) throw new Error('Captured review watch sender unavailable');
      await captured.bridge.watch(request, captured.guard);
    } finally {
      admission.finish();
    }
  });
  ipc.handle(AGENT_BACKEND_REVIEW_UNWATCH_CHANNEL, (event, value: unknown) => {
    const captured = authorization.captureCleanup(event);
    if (!captured) throw new Error('Captured review watch sender unavailable');
    const request = readCapturedReviewUnwatchRequest(value);
    order.cancel(captured.owner, request);
    captured.bridge?.unwatch(request);
  });
  return () => {
    order.dispose();
    ipc.removeHandler(AGENT_BACKEND_REVIEW_WATCH_CHANNEL);
    ipc.removeHandler(AGENT_BACKEND_REVIEW_UNWATCH_CHANNEL);
  };
}
