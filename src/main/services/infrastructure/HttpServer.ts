/**
 * HttpServer - Fastify-based HTTP server for serving the renderer UI and API routes.
 *
 * Binds to 127.0.0.1 only for localhost security.
 * Dynamically allocates a port starting from 3456.
 * In production, serves static files from the renderer output directory.
 * In development, Vite dev server handles static files.
 */

import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { type HttpServices, registerHttpRoutes } from '@main/http';
import { broadcastEvent } from '@main/http/events';
import { createLogger } from '@shared/utils/logger';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';

import {
  assertHttpServerBindAllowed,
  extractBearerAuthToken,
  getHttpAuthTokenFromEnv,
  timingSafeHttpAuthTokenEquals,
} from './httpServerAuth';

const logger = createLogger('Service:HttpServer');

/**
 * Resolves the renderer output directory from multiple candidate paths.
 * Returns the first path that exists on disk.
 */
function resolveRendererPath(): string | null {
  const candidates = [
    // Fallback: relative to cwd (dev mode, standalone)
    join(process.cwd(), 'out/renderer'),
  ];

  if (typeof __dirname === 'string') {
    candidates.unshift(
      // Standalone: dist-standalone/index.cjs → ../out/renderer
      join(__dirname, '../out/renderer'),
      // Electron production (asarUnpack): app.asar.unpacked/out/renderer (real filesystem)
      join(__dirname, '../../out/renderer').replace('app.asar', 'app.asar.unpacked'),
      // Electron production fallback: app.asar/out/renderer
      join(__dirname, '../../out/renderer')
    );
  }

  // Allow explicit override via env
  if (process.env.RENDERER_PATH) {
    candidates.unshift(process.env.RENDERER_PATH);
  }

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function isCorsPreflightRequest(request: {
  method: string;
  headers: Record<string, unknown>;
}): boolean {
  return (
    request.method === 'OPTIONS' &&
    typeof request.headers.origin === 'string' &&
    typeof request.headers['access-control-request-method'] === 'string'
  );
}

async function registerHttpCors(
  app: FastifyInstance,
  corsOrigin: string | undefined
): Promise<void> {
  const configuredOrigins = corsOrigin
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configuredOrigins?.includes('*')) {
    await app.register(cors, {
      origin: (origin, cb) => {
        cb(null, origin || false);
      },
      credentials: true,
    });
  } else if (configuredOrigins && configuredOrigins.length > 0) {
    await app.register(cors, { origin: configuredOrigins, credentials: true });
  } else {
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored, no backtracking risk
    const localhostPattern = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;
    await app.register(cors, {
      origin: (origin, cb) => {
        if (!origin) {
          cb(null, true);
          return;
        }
        if (localhostPattern.test(origin)) {
          cb(null, true);
          return;
        }
        cb(new Error('Not allowed by CORS'), false);
      },
      credentials: true,
    });
  }
}

async function registerHttpAuth(app: FastifyInstance, authToken: string | null): Promise<void> {
  if (!authToken) {
    return;
  }

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) {
      return;
    }

    if (isCorsPreflightRequest(request)) {
      return;
    }

    const receivedToken = extractBearerAuthToken(request.headers.authorization);
    if (receivedToken && timingSafeHttpAuthTokenEquals(authToken, receivedToken)) {
      return;
    }

    await reply.status(401).send({ success: false, error: 'Unauthorized' });
  });
}

export async function registerHttpSecurityMiddleware(
  app: FastifyInstance,
  authToken: string | null,
  corsOrigin: string | undefined = process.env.CORS_ORIGIN
): Promise<void> {
  await registerHttpCors(app, corsOrigin);
  await registerHttpAuth(app, authToken);
}

export class HttpServer {
  private app: FastifyInstance | null = null;
  private port: number = 3456;
  private running: boolean = false;
  private startingPromise: Promise<number> | null = null;

  /**
   * Start the HTTP server.
   * Deduplicates concurrent calls — if start() is already in progress,
   * subsequent calls await the same promise.
   * @param services - Service instances to pass to route handlers
   * @param sshModeSwitchCallback - Callback for SSH mode switching
   * @param preferredPort - Port to try first (default 3456)
   * @param host - Host to bind to (default '127.0.0.1')
   */
  async start(
    services: HttpServices,
    sshModeSwitchCallback: (mode: 'local' | 'ssh') => Promise<void>,
    preferredPort: number = 3456,
    host: string = '127.0.0.1'
  ): Promise<number> {
    if (this.startingPromise) {
      return this.startingPromise;
    }

    this.startingPromise = this.doStart(services, sshModeSwitchCallback, preferredPort, host);
    try {
      return await this.startingPromise;
    } finally {
      this.startingPromise = null;
    }
  }

  private async doStart(
    services: HttpServices,
    sshModeSwitchCallback: (mode: 'local' | 'ssh') => Promise<void>,
    preferredPort: number,
    host: string
  ): Promise<number> {
    const authToken = getHttpAuthTokenFromEnv();
    assertHttpServerBindAllowed(host, authToken);

    this.app = Fastify({ logger: false });
    await registerHttpSecurityMiddleware(this.app, authToken);

    // Register static file serving and SPA fallback when renderer output exists.
    // In dev mode this requires a prior `pnpm build`; in production/standalone it's always present.
    const rendererPath = resolveRendererPath();
    if (rendererPath) {
      logger.info(`Serving static files from: ${rendererPath}`);

      // Cache index.html for SPA fallback (async to avoid blocking main thread)
      const indexHtml = await readFile(join(rendererPath, 'index.html'), 'utf-8');

      await this.app.register(fastifyStatic, {
        root: rendererPath,
        prefix: '/',
        wildcard: false,
      });

      // Register all API routes BEFORE the not-found handler
      registerHttpRoutes(this.app, services, sshModeSwitchCallback);

      // SPA fallback: serve index.html for all non-API routes
      this.app.setNotFoundHandler(async (request, reply) => {
        if (request.url.startsWith('/api/')) {
          return reply.status(404).send({ error: 'Not found' });
        }
        return reply.type('text/html').send(indexHtml);
      });
    } else {
      logger.warn('Renderer output directory not found (run `pnpm build` first), serving API only');
      registerHttpRoutes(this.app, services, sshModeSwitchCallback);
    }

    // Try ports starting from preferredPort
    for (let attempt = 0; attempt <= 10; attempt++) {
      const tryPort = preferredPort + attempt;
      try {
        await this.app.listen({ host, port: tryPort });
        const address = this.app.server.address();
        this.port = address && typeof address !== 'string' ? address.port : tryPort;
        this.running = true;
        logger.info(`HTTP server started on http://${host}:${this.port}`);
        return this.port;
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === 'EADDRINUSE') {
          logger.info(`Port ${tryPort} in use, trying next...`);
          continue;
        }
        throw err;
      }
    }

    throw new Error(`Could not find available port (tried ${preferredPort}-${preferredPort + 10})`);
  }

  /**
   * Stop the HTTP server gracefully.
   */
  async stop(): Promise<void> {
    if (this.app && this.running) {
      await this.app.close();
      this.running = false;
      this.app = null;
      logger.info('HTTP server stopped');
    }
  }

  /**
   * Broadcast an event to all connected SSE clients.
   */
  broadcast(channel: string, data: unknown): void {
    broadcastEvent(channel, data);
  }

  /**
   * Get the current port the server is running on.
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Check if the server is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }
}
