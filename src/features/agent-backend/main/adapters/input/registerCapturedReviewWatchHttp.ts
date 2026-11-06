import {
  AGENT_BACKEND_REVIEW_UNWATCH_ROUTE,
  AGENT_BACKEND_REVIEW_WATCH_ROUTE,
} from '../../../contracts/reviewWatch';

import { createReviewWatchAdmissionOrder } from './createReviewWatchAdmissionOrder';
import {
  readCapturedReviewUnwatchRequest,
  readCapturedReviewWatchRequest,
} from './registerCapturedReviewWatchIpc';

import type { BackendReviewWatchRequest } from '../../../contracts/reviewWatch';
import type { CapturedReviewWatch } from './CapturedReviewWatch';
import type { CapturedReviewWatchAdmission } from './registerCapturedReviewWatchIpc';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export interface CapturedReviewWatchHttpAuthorization {
  /** Returned bridge must publish events only to this same captured server authority. */
  captureWatch(
    request: FastifyRequest,
    value: BackendReviewWatchRequest
  ): Promise<CapturedReviewWatchAdmission | null>;
  /** Captured exact-owner cleanup is synchronous and may outlive its operation epoch. */
  captureCleanup(request: FastifyRequest): CapturedReviewWatch | null;
}

/** Feature route adapter only; the application HTTP bootstrap must explicitly supply authority/events. */
export function registerCapturedReviewWatchHttp(
  app: FastifyInstance,
  authorization: CapturedReviewWatchHttpAuthorization
): void {
  const order = createReviewWatchAdmissionOrder();
  app.addHook('onClose', async () => {
    order.dispose();
  });
  app.post(AGENT_BACKEND_REVIEW_WATCH_ROUTE, { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const value = readCapturedReviewWatchRequest(request.body);
    const original = authorization.captureCleanup(request);
    if (!original) return reply.code(403).send();
    const admission = order.begin(original, value);
    try {
      const captured = await authorization.captureWatch(request, value);
      if (!admission.isCurrent()) return reply.code(204).send();
      if (!captured || captured.bridge !== original) return reply.code(403).send();
      await captured.bridge.watch(value, captured.guard);
      return reply.code(204).send();
    } finally {
      admission.finish();
    }
  });
  app.post(AGENT_BACKEND_REVIEW_UNWATCH_ROUTE, { bodyLimit: 1024 * 1024 }, (request, reply) => {
    const bridge = authorization.captureCleanup(request);
    if (!bridge) return reply.code(403).send();
    const value = readCapturedReviewUnwatchRequest(request.body);
    order.cancel(bridge, value);
    bridge.unwatch(value);
    return reply.code(204).send();
  });
}
