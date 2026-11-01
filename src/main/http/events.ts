/**
 * SSE (Server-Sent Events) route for real-time event streaming.
 *
 * Routes:
 * - GET /api/events: SSE stream with keep-alive pings
 */

import { createLogger } from '@shared/utils/logger';

import type { FastifyInstance, FastifyReply } from 'fastify';

const logger = createLogger('HTTP:events');

const KEEPALIVE_INTERVAL_MS = 30_000;

/** All connected SSE clients */
const clients = new Map<FastifyReply, FastifyInstance>();

/**
 * Registers the SSE events endpoint.
 */
export function registerEventRoutes(app: FastifyInstance): void {
  app.get('/api/events', async (request, reply) => {
    // Raw streaming bypasses Fastify's send hooks; retain admission/CORS headers.
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'keep-alive',
    });
    reply.raw.flushHeaders();

    clients.set(reply, app);
    logger.info(`SSE client connected (total: ${clients.size})`);

    // Keep-alive ping
    const timer = setInterval(() => {
      reply.raw.write(':ping\n\n');
    }, KEEPALIVE_INTERVAL_MS);
    // Keepalive should not prevent shutdown (socket already keeps connection alive).
    timer.unref();

    // Cleanup on disconnect
    request.raw.on('close', () => {
      clearInterval(timer);
      clients.delete(reply);
      logger.info(`SSE client disconnected (total: ${clients.size})`);
    });

    // Prevent Fastify from ending the response
    await reply;
  });
}

/**
 * Broadcasts an event to all connected SSE clients.
 */
export function broadcastEvent(channel: string, data: unknown): void {
  const payload = `event: ${channel}\ndata: ${JSON.stringify(data)}\n\n`;

  for (const client of clients.keys()) {
    try {
      client.raw.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

/** Retire streams with the physical listener before closing or changing credentials. */
export function closeEventStreams(app: FastifyInstance): void {
  for (const [client, owner] of clients) {
    if (owner !== app) continue;
    clients.delete(client);
    client.raw.end();
  }
}
