/**
 * SSE (Server-Sent Events) route for real-time event streaming.
 *
 * Routes:
 * - GET /api/events: SSE stream with keep-alive pings
 */

import { createLogger } from '@shared/utils/logger';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const logger = createLogger('HTTP:events');
const KEEPALIVE_INTERVAL_MS = 30_000;
const AUTHORIZATION_TIMEOUT_MS = 5_000;
const MAX_PENDING_DELIVERIES = 64;
const MAX_PENDING_HOSTED_SOURCE_EVENTS = 64;
const MAX_HOSTED_SESSION_ATTRIBUTIONS = 4_096;
const HOSTED_SESSION_ATTRIBUTION_TTL_MS = 60 * 60 * 1_000;

type HostedWorkspaceEventChannel = 'file-change' | 'notification:new' | 'todo-change';

export interface HostedWorkspaceEventSource {
  on(event: string, listener: (data: unknown) => void): unknown;
  off(event: string, listener: (data: unknown) => void): unknown;
}

export interface HostedWorkspaceEventBridge {
  drain(): Promise<void>;
  close(): Promise<void>;
}

export interface HostedWorkspaceEventBridgeDependencies {
  readonly fileEvents: HostedWorkspaceEventSource;
  readonly notificationEvents: HostedWorkspaceEventSource;
  readonly isWorkspaceRegistered: (runtimeWorkspaceId: string) => Promise<boolean>;
  readonly broadcast: (channel: HostedWorkspaceEventChannel, data: unknown) => void;
  readonly nowMs?: () => number;
}

interface HostedSessionAttribution {
  readonly runtimeWorkspaceIds: readonly string[] | null;
  readonly observedAt: number;
}

export interface EventStreamAuthorization {
  authorize(request: FastifyRequest): Promise<boolean>;
  project(request: FastifyRequest, channel: string, data: unknown): Promise<unknown>;
}

interface EventClient {
  readonly reply: FastifyReply;
  readonly request: FastifyRequest;
  readonly authorization: EventStreamAuthorization | undefined;
  delivery: Promise<void>;
  pendingDeliveries: number;
}

/** All connected SSE clients. Each hosted delivery revalidates its session. */
const clients = new Set<EventClient>();
let streamDrainDepth = 0;

function closeClient(client: EventClient): void {
  clients.delete(client);
  if (!client.reply.raw.destroyed) client.reply.raw.end();
}

function authorizeWithinDeadline(client: EventClient): Promise<boolean> {
  const authorization = client.authorization;
  if (!authorization) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (authorized: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(authorized);
    };
    const timer = setTimeout(() => finish(false), AUTHORIZATION_TIMEOUT_MS);
    timer.unref();
    void authorization
      .authorize(client.request)
      .then((authorized) => finish(authorized))
      .catch(() => finish(false));
  });
}

type EventDelivery =
  | { readonly kind: 'keepalive' }
  | { readonly kind: 'event'; readonly channel: string; readonly data: unknown };

function enqueue(client: EventClient, delivery: EventDelivery): void {
  if (!clients.has(client)) return;
  if (client.pendingDeliveries >= MAX_PENDING_DELIVERIES) {
    closeClient(client);
    return;
  }
  client.pendingDeliveries += 1;
  client.delivery = client.delivery
    .then(async () => {
      if (!clients.has(client)) return;
      if (!(await authorizeWithinDeadline(client))) {
        closeClient(client);
        return;
      }
      if (client.reply.raw.destroyed) return;
      if (delivery.kind === 'keepalive') {
        client.reply.raw.write(':ping\n\n');
        return;
      }
      const data = client.authorization
        ? await client.authorization.project(client.request, delivery.channel, delivery.data)
        : delivery.data;
      if (data === null) return;
      client.reply.raw.write(`event: ${delivery.channel}\ndata: ${JSON.stringify(data)}\n\n`);
    })
    .catch(() => closeClient(client))
    .finally(() => {
      client.pendingDeliveries -= 1;
    });
}

/**
 * Registers the SSE events endpoint. Hosted streams revalidate the opaque
 * session before every event and keepalive, bounding revocation propagation.
 */
export function registerEventRoutes(
  app: FastifyInstance,
  authorization?: EventStreamAuthorization
): void {
  app.get('/api/events', async (request, reply) => {
    if (streamDrainDepth > 0) {
      return reply.code(503).send({ error: 'event_stream_draining' });
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const client: EventClient = {
      reply,
      request,
      authorization,
      delivery: Promise.resolve(),
      pendingDeliveries: 0,
    };
    clients.add(client);
    logger.info(`SSE client connected (total: ${clients.size})`);

    const timer = setInterval(() => {
      enqueue(client, { kind: 'keepalive' });
    }, KEEPALIVE_INTERVAL_MS);
    timer.unref();

    request.raw.on('close', () => {
      clearInterval(timer);
      clients.delete(client);
      logger.info(`SSE client disconnected (total: ${clients.size})`);
    });

    await reply;
  });
}

export function broadcastEvent(channel: string, data: unknown): void {
  for (const client of clients) enqueue(client, { kind: 'event', channel, data });
}

function eventRecord(data: unknown): Record<string, unknown> | null {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

function containsAsciiControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function runtimeWorkspaceId(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1_024 &&
    !containsAsciiControl(value)
    ? value
    : null;
}

function sessionId(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !containsAsciiControl(value)
    ? value
    : null;
}

function sanitizeHostedWorkspaceEvent(
  source: Record<string, unknown>,
  attributedRuntimeWorkspaceId: string
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {
    ...source,
    projectId: attributedRuntimeWorkspaceId,
  };
  delete result.filePath;
  delete result.fullPath;
  delete result.path;
  const context = eventRecord(result.context);
  if (context !== null) {
    const safeContext = { ...context };
    delete safeContext.cwd;
    result.context = safeContext;
  }
  return Object.freeze(result);
}

/**
 * Admits hosted browser events only after binding them to one active,
 * administrator-registered runtime workspace. Direct file/error events seed a
 * bounded session correlation cache; task-list events without a project ID are
 * admitted only when that cache resolves the session to exactly one workspace.
 * Per-user grant projection still occurs at SSE delivery time.
 */
export function registerHostedWorkspaceEventBridge(
  dependencies: HostedWorkspaceEventBridgeDependencies
): HostedWorkspaceEventBridge {
  const sessionAttributions = new Map<string, HostedSessionAttribution>();
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;
  let closed = false;

  const now = (): number => {
    const value = dependencies.nowMs?.() ?? Date.now();
    return Number.isFinite(value) ? value : Date.now();
  };

  const pruneAttributions = (at: number): void => {
    for (const [key, attribution] of sessionAttributions) {
      if (
        at < attribution.observedAt ||
        at - attribution.observedAt >= HOSTED_SESSION_ATTRIBUTION_TTL_MS
      ) {
        sessionAttributions.delete(key);
      }
    }
    while (sessionAttributions.size > MAX_HOSTED_SESSION_ATTRIBUTIONS) {
      const oldest = sessionAttributions.keys().next().value;
      if (oldest === undefined) break;
      sessionAttributions.delete(oldest);
    }
  };

  const rememberAttribution = (
    observedSessionId: string,
    attributedRuntimeWorkspaceId: string
  ): void => {
    const observedAt = now();
    pruneAttributions(observedAt);
    const existing = sessionAttributions.get(observedSessionId);
    sessionAttributions.delete(observedSessionId);
    const existingRuntimeWorkspaceIds = existing?.runtimeWorkspaceIds;
    let nextRuntimeWorkspaceIds: readonly string[] | null;
    if (existingRuntimeWorkspaceIds === null) {
      nextRuntimeWorkspaceIds = null;
    } else if (existingRuntimeWorkspaceIds === undefined) {
      nextRuntimeWorkspaceIds = [attributedRuntimeWorkspaceId];
    } else if (existingRuntimeWorkspaceIds.includes(attributedRuntimeWorkspaceId)) {
      nextRuntimeWorkspaceIds = existingRuntimeWorkspaceIds;
    } else if (existingRuntimeWorkspaceIds.length === 1) {
      nextRuntimeWorkspaceIds = [...existingRuntimeWorkspaceIds, attributedRuntimeWorkspaceId];
    } else {
      nextRuntimeWorkspaceIds = null;
    }
    sessionAttributions.set(observedSessionId, {
      runtimeWorkspaceIds: nextRuntimeWorkspaceIds,
      observedAt,
    });
    pruneAttributions(observedAt);
  };

  const lookupAttribution = (observedSessionId: string): readonly string[] | null => {
    const observedAt = now();
    pruneAttributions(observedAt);
    return sessionAttributions.get(observedSessionId)?.runtimeWorkspaceIds ?? null;
  };

  const registered = async (candidate: string): Promise<boolean> => {
    try {
      return await dependencies.isWorkspaceRegistered(candidate);
    } catch {
      return false;
    }
  };

  const admitDirectEvent = async (
    channel: 'file-change' | 'notification:new',
    data: unknown
  ): Promise<void> => {
    const source = eventRecord(data);
    if (source === null) return;
    if (
      channel === 'notification:new' &&
      source.category !== undefined &&
      source.category !== 'error'
    ) {
      return;
    }
    const attributedRuntimeWorkspaceId = runtimeWorkspaceId(source.projectId);
    if (
      attributedRuntimeWorkspaceId === null ||
      !(await registered(attributedRuntimeWorkspaceId)) ||
      closed
    ) {
      return;
    }
    const observedSessionId = sessionId(source.sessionId);
    if (observedSessionId !== null) {
      rememberAttribution(observedSessionId, attributedRuntimeWorkspaceId);
    }
    dependencies.broadcast(
      channel,
      sanitizeHostedWorkspaceEvent(source, attributedRuntimeWorkspaceId)
    );
  };

  const admitTodoEvent = async (data: unknown): Promise<void> => {
    const source = eventRecord(data);
    if (source === null) return;
    const observedSessionId = sessionId(source.sessionId);
    if (observedSessionId === null) return;
    const candidates = lookupAttribution(observedSessionId);
    if (candidates === null) return;
    const registrations = await Promise.all(
      candidates.map(async (candidate) => ({
        candidate,
        registered: await registered(candidate),
      }))
    );
    const activeCandidates = registrations.filter((candidate) => candidate.registered);
    if (activeCandidates.length !== 1 || closed) return;
    const attributedRuntimeWorkspaceId = activeCandidates[0].candidate;
    dependencies.broadcast(
      'todo-change',
      sanitizeHostedWorkspaceEvent(source, attributedRuntimeWorkspaceId)
    );
  };

  const schedule = (channel: HostedWorkspaceEventChannel, data: unknown): void => {
    if (closed || pending >= MAX_PENDING_HOSTED_SOURCE_EVENTS) return;
    pending += 1;
    queue = queue
      .then(() =>
        channel === 'todo-change' ? admitTodoEvent(data) : admitDirectEvent(channel, data)
      )
      .catch(() => undefined)
      .finally(() => {
        pending -= 1;
      });
  };

  const fileChangeListener = (data: unknown): void => schedule('file-change', data);
  const todoChangeListener = (data: unknown): void => schedule('todo-change', data);
  const notificationListener = (data: unknown): void => schedule('notification:new', data);

  dependencies.fileEvents.on('file-change', fileChangeListener);
  dependencies.fileEvents.on('todo-change', todoChangeListener);
  dependencies.notificationEvents.on('notification-new', notificationListener);

  return Object.freeze({
    drain: () => queue,
    close: async () => {
      if (!closed) {
        closed = true;
        dependencies.fileEvents.off('file-change', fileChangeListener);
        dependencies.fileEvents.off('todo-change', todoChangeListener);
        dependencies.notificationEvents.off('notification-new', notificationListener);
      }
      await queue;
      sessionAttributions.clear();
    },
  });
}

export async function runWithEventStreamsDrained<Value>(
  operation: () => Promise<Value>
): Promise<Value> {
  streamDrainDepth += 1;
  try {
    for (const client of [...clients]) closeClient(client);
    return await operation();
  } finally {
    streamDrainDepth -= 1;
  }
}
