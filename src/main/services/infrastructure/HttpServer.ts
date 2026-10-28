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
import { ProfileRequestDrain, registerProfileParticipant } from '@features/local-http-auth/main';
import { type HttpServices, registerHttpRoutes } from '@main/http';
import { broadcastEvent, closeEventStreams } from '@main/http/events';
import { createLogger } from '@shared/utils/logger';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';

import {
  buildHttpAccessUrl,
  createHttpAuthToken,
  exactHttpOrigins,
  registerHttpApiAuth,
} from './HttpServerAuth';

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

export class HttpServer {
  private app: FastifyInstance | null = null;
  private port: number = 3456;
  private running: boolean = false;
  private startingPromise: Promise<number> | null = null;
  private startingRevision: number | null = null;
  private closingPromise: Promise<void> | null = null;
  private physicalClosing: Promise<void> | null = null;
  private stopRevision = 0;
  private authToken: string | null = null;
  private host: string = '127.0.0.1';
  private publicOrigin: string | null = null;
  private drain: ProfileRequestDrain | null = null;
  private unregisterProfile: (() => void) | null = null;
  private lastStart: Parameters<HttpServer['start']> | null = null;

  constructor(
    private readonly options: {
      getServices?: () => HttpServices;
      afterRestart?: () => Promise<void>;
    } = {}
  ) {}

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
      const revision = this.startingRevision;
      const port = await this.startingPromise;
      if (revision !== this.stopRevision) throw new Error('HTTP startup cancelled by stop');
      return port;
    }

    const startRevision = this.stopRevision;
    this.startingRevision = startRevision;
    this.lastStart = [services, sshModeSwitchCallback, preferredPort, host];
    this.startingPromise = (async () => {
      await this.closingPromise;
      await this.physicalClosing;
      if (startRevision !== this.stopRevision) throw new Error('HTTP startup cancelled by stop');
      if (this.app && this.drain?.paused) await this.closeCurrentApp();
      return this.doStart(services, sshModeSwitchCallback, preferredPort, host);
    })();
    try {
      const port = await this.startingPromise;
      if (startRevision !== this.stopRevision) throw new Error('HTTP startup cancelled by stop');
      return port;
    } catch (error) {
      const failed = this.app;
      this.authToken = null;
      this.app = null;
      this.running = false;
      if (failed) {
        closeEventStreams(failed);
        await failed.close().catch(() => undefined);
      }
      throw error;
    } finally {
      this.startingPromise = null;
      this.startingRevision = null;
    }
  }

  private async doStart(
    services: HttpServices,
    sshModeSwitchCallback: (mode: 'local' | 'ssh') => Promise<void>,
    preferredPort: number,
    host: string
  ): Promise<number> {
    if (this.running) return this.port;
    this.authToken = createHttpAuthToken();
    this.host = host;
    this.app = Fastify({ logger: false });
    this.drain = new ProfileRequestDrain(this.app);
    const publicOrigins = exactHttpOrigins(process.env.AGENT_TEAMS_HTTP_PUBLIC_ORIGIN);
    if (publicOrigins.length > 1)
      throw new Error('AGENT_TEAMS_HTTP_PUBLIC_ORIGIN requires one exact origin');
    this.publicOrigin = publicOrigins[0] ?? null;
    const origins = [...exactHttpOrigins(process.env.CORS_ORIGIN), ...publicOrigins];
    registerHttpApiAuth(this.app, () => this.authToken, {
      origins,
      authorities: () => {
        const hosts =
          host === '0.0.0.0' || host === '::'
            ? ['localhost', '127.0.0.1', '[::1]']
            : [host.includes(':') ? `[${host}]` : host];
        return [
          ...hosts.map((name) => `${name}:${this.port}`),
          ...publicOrigins.map((origin) => new URL(origin).host),
        ];
      },
    });
    await this.app.register(cors, {
      origin: (origin, callback) =>
        callback(
          null,
          !origin || origins.includes(origin) || origin === buildHttpAccessUrl(host, this.port)
        ),
      credentials: false,
      allowedHeaders: ['content-type', 'authorization', 'x-agent-teams-app-context'],
    });
    this.app.get('/api/auth/ready', () => ({ ready: true, service: 'api' }));

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
        this.unregisterProfile = registerProfileParticipant({
          pause: async (request) => {
            const revision = this.stopRevision;
            const drain = this.drain!;
            drain.paused = true;
            if (this.app) closeEventStreams(this.app);
            await drain.wait(request);
            return async () => {
              await drain.wait();
              if (revision !== this.stopRevision)
                throw new Error('HTTP server was stopped during profile change');
              const previous = this.lastStart;
              await this.closeCurrentApp();
              if (revision !== this.stopRevision)
                throw new Error('HTTP server was stopped during profile change');
              if (!previous) return;
              const current = this.options.getServices?.() ?? previous[0];
              await this.start(current, previous[1], previous[2], previous[3]);
              if (revision !== this.stopRevision)
                throw new Error('HTTP server was stopped during profile change');
              try {
                await this.options.afterRestart?.();
              } catch (error) {
                await this.stop();
                throw error;
              }
            };
          },
        });
        logger.info(`HTTP server started on http://${host}:${tryPort}`);
        return tryPort;
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
  stop(): Promise<void> {
    ++this.stopRevision;
    if (this.closingPromise) return this.closingPromise;
    const starting = this.startingPromise;
    this.closingPromise = (async () => {
      await starting?.catch(() => undefined);
      await this.closeCurrentApp();
    })().finally(() => {
      this.closingPromise = null;
    });
    return this.closingPromise;
  }

  private closeCurrentApp(): Promise<void> {
    if (this.physicalClosing) return this.physicalClosing;
    const app = this.app,
      drain = this.drain;
    if (drain) drain.paused = true;
    this.unregisterProfile?.();
    this.unregisterProfile = null;
    this.authToken = null;
    this.running = false;
    this.app = null;
    this.physicalClosing = (async () => {
      if (app) {
        closeEventStreams(app);
        await drain?.wait();
        await app.close();
        logger.info('HTTP server stopped');
      }
    })().finally(() => {
      this.physicalClosing = null;
    });
    return this.physicalClosing;
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
    return this.running && this.drain?.paused !== true;
  }

  getAuthToken(): string | null {
    return this.running ? this.authToken : null;
  }

  getAccessUrl(): string | null {
    return this.running && this.authToken
      ? (this.publicOrigin ?? buildHttpAccessUrl(this.host, this.port))
      : null;
  }
}
