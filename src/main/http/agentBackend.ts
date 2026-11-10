import {
  AGENT_BACKEND_REVIEW_EVENTS_ROUTE,
  AGENT_BACKEND_REVIEW_FILE_CHANGE_CHANNEL,
  STOPPED_TEAM_IMPORT_ROUTE,
} from '@features/agent-backend/contracts';
import {
  createCapturedReviewWatch,
  registerAgentBackendHttp,
  registerBackendConnectionsHttp,
  registerCapturedReviewWatchHttp,
} from '@features/agent-backend/main';

import { writeReviewSse } from './writeReviewSse';

import type {
  BackendReviewFileChangeEvent,
  StoppedTeamImportResult,
} from '@features/agent-backend/contracts';
import type { CapturedReviewWatch, DesktopBackendFeature } from '@features/agent-backend/main';
import type { FastifyInstance, FastifyReply } from 'fastify';

/** Captured by the server composition, never selected by an HTTP body/query/current-default lookup. */
export interface HttpAgentBackendScope {
  readonly feature: DesktopBackendFeature;
  readonly contextId: string;
  readonly isCurrent: () => boolean;
  readonly importStoppedTeam?: (request: unknown) => Promise<StoppedTeamImportResult>;
}

const MAX_REVIEW_STREAMS = 32;
const MAX_REVIEW_WATCHES = 64;

/** Uses the app's existing trusted-local HTTP authority; this does not add public-server authentication. */
export function registerHttpAgentBackend(
  app: FastifyInstance,
  scope: HttpAgentBackendScope,
  options: { createWatcher?: Parameters<typeof createCapturedReviewWatch>[0]['createWatcher'] } = {}
): void {
  const feature = scope.feature;
  const contextId = scope.contextId;
  const originalCurrent = scope.isCurrent.bind(scope);
  const importStoppedTeam = scope.importStoppedTeam?.bind(scope);
  let closed = false;
  const isCurrent = () => !closed && originalCurrent();
  const guardFor = (handle: { handleId: string }) => ({
    isCurrent: () => isCurrent() && feature.authorizeHandle(contextId, handle),
  });
  registerBackendConnectionsHttp(app, feature, () => (isCurrent() ? contextId : null));
  registerAgentBackendHttp(app, feature.facade, async (_request, operation) => {
    if (!isCurrent()) return false;
    await feature.initialize();
    const guard = guardFor(operation.handle);
    return guard.isCurrent() ? guard : false;
  });
  app.post(STOPPED_TEAM_IMPORT_ROUTE, { bodyLimit: 4096 }, (request) =>
    Object.keys(request.query ?? {}).length
      ? { ok: false, reason: 'invalid', outcome: 'not-dispatched' }
      : isCurrent() && importStoppedTeam
        ? importStoppedTeam(request.body)
        : { ok: false, reason: 'unsupported', outcome: 'not-dispatched' }
  );

  const streams = new Set<FastifyReply>();
  function publish(event: BackendReviewFileChangeEvent): boolean {
    if (!isCurrent()) {
      closeStreams();
      return false;
    }
    const message = `event: ${AGENT_BACKEND_REVIEW_FILE_CHANGE_CHANNEL}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const stream of streams) {
      try {
        if (!writeReviewSse(stream.raw, message)) streams.delete(stream);
      } catch {
        streams.delete(stream);
        stream.raw.destroy();
      }
    }
    return true;
  }
  function closeStreams(): void {
    for (const stream of streams) stream.raw.destroy();
    streams.clear();
  }
  const mechanism = createCapturedReviewWatch({
    facade: feature.facade,
    window: null,
    createWatcher: options.createWatcher,
    send: (_window, _channel, event) => publish(event),
  });
  const retained = new Map<string, object>();
  const key = (value: { handle: { handleId: string }; watchId: string }) =>
    JSON.stringify([value.handle.handleId, value.watchId]);
  const bridge: CapturedReviewWatch = {
    async watch(request, guard) {
      const id = key(request);
      if (!retained.has(id) && retained.size >= MAX_REVIEW_WATCHES)
        throw new Error('HTTP review watch capacity exceeded');
      const token = {};
      retained.set(id, token);
      try {
        await mechanism.watch(request, guard);
      } catch (error) {
        if (retained.get(id) === token) retained.delete(id);
        throw error;
      }
    },
    unwatch(request) {
      retained.delete(key(request));
      mechanism.unwatch(request);
    },
    dispose() {
      retained.clear();
      mechanism.dispose();
    },
  };
  registerCapturedReviewWatchHttp(app, {
    async captureWatch(_request, request) {
      if (!isCurrent()) return null;
      await feature.initialize();
      const guard = guardFor(request.handle);
      return guard.isCurrent() ? { bridge, guard } : null;
    },
    // Cleanup is exact, stop-only, and may outlive the captured context epoch.
    captureCleanup: () => (!closed ? bridge : null),
  });
  app.get(AGENT_BACKEND_REVIEW_EVENTS_ROUTE, (request, reply) => {
    if (!isCurrent()) return reply.code(403).send();
    if (streams.size >= MAX_REVIEW_STREAMS) return reply.code(503).send();
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    streams.add(reply);
    if (!writeReviewSse(reply.raw, ':captured-review-ready\n\n')) {
      streams.delete(reply);
      return;
    }
    const timer = setInterval(() => {
      if (!isCurrent()) {
        reply.raw.end();
        return;
      }
      if (!writeReviewSse(reply.raw, ':ping\n\n')) streams.delete(reply);
    }, 30_000);
    timer.unref();
    reply.raw.once('close', () => {
      clearInterval(timer);
      streams.delete(reply);
    });
    request.raw.once('aborted', () => reply.raw.end());
  });
  app.addHook('preClose', async () => {
    closed = true;
    bridge.dispose();
    closeStreams();
  });
}
