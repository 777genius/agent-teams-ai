import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HostedServerConfig {
  host: string;
  port: number;
  rendererRoot: string;
}

export interface HostedServerHandle {
  close: () => Promise<void>;
  port: number;
  server: Server;
  url: string;
}

export interface HostedStaticResolution {
  cacheControl?: string;
  contentType?: string;
  filePath?: string;
  statusCode: number;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3456;
const DEFAULT_RENDERER_ROOT = 'out/renderer';
const HOSTED_SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const REMOTE_BIND_OPT_IN = 'HOSTED_ALLOW_REMOTE';

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
};

function parsePort(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid hosted server port: ${value}`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`Invalid hosted server port: ${value}`);
  }
  return parsed;
}

function isLoopbackHost(host: string): boolean {
  return host === DEFAULT_HOST || host === 'localhost' || host === '::1' || host === '[::1]';
}

function parseHost(env: NodeJS.ProcessEnv): string {
  const host = env.HOST?.trim() || DEFAULT_HOST;
  if (!isLoopbackHost(host) && env[REMOTE_BIND_OPT_IN] !== '1') {
    throw new Error(
      `Hosted server remote binding requires ${REMOTE_BIND_OPT_IN}=1. Prefer HOST=${DEFAULT_HOST}.`
    );
  }
  return host;
}

function firstExistingPath(paths: string[]): string {
  return paths.find((candidate) => existsSync(candidate)) ?? paths[0];
}

export function resolveHostedServerConfig(
  env: NodeJS.ProcessEnv = process.env
): HostedServerConfig {
  return {
    host: parseHost(env),
    port: parsePort(env.PORT, DEFAULT_PORT),
    rendererRoot: firstExistingPath([
      resolve(process.cwd(), DEFAULT_RENDERER_ROOT),
      resolve(HOSTED_SOURCE_DIR, '..', DEFAULT_RENDERER_ROOT),
    ]),
  };
}

function sendStatus(reply: ServerResponse, statusCode: number): void {
  reply.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': '0',
  });
  reply.end();
}

function resolveStaticFile(rendererRoot: string, requestUrl: string | undefined): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl || '/', 'http://hosted.local');
  } catch {
    return null;
  }
  const rawPathname = url.pathname === '/' ? '/index.html' : url.pathname;
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }

  const normalizedPath = normalize(decodedPathname).replace(/^[/\\]+/, '');
  const candidate = resolve(rendererRoot, normalizedPath);
  const rel = relative(rendererRoot, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('/')) {
    return null;
  }
  return candidate;
}

function isReadableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveHostedStaticRequest(
  config: HostedServerConfig,
  method: string | undefined,
  requestUrl: string | undefined
): HostedStaticResolution {
  if (method !== 'GET' && method !== 'HEAD') {
    return { statusCode: 405 };
  }

  const candidate = resolveStaticFile(config.rendererRoot, requestUrl);
  if (!candidate) {
    return { statusCode: 404 };
  }

  const pathname = new URL(requestUrl || '/', 'http://hosted.local').pathname;
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return { statusCode: 404 };
  }

  const indexPath = join(config.rendererRoot, 'index.html');
  const filePath =
    candidate && existsSync(candidate) && isReadableFile(candidate)
      ? candidate
      : extname(pathname)
        ? null
        : indexPath;

  if (!filePath || !existsSync(filePath) || !isReadableFile(filePath)) {
    return { statusCode: 404 };
  }

  return {
    cacheControl: filePath === indexPath ? 'no-cache' : 'public, max-age=31536000, immutable',
    contentType: MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
    filePath,
    statusCode: 200,
  };
}

function sendStaticFile(
  config: HostedServerConfig,
  request: IncomingMessage,
  reply: ServerResponse
): void {
  const resolution = resolveHostedStaticRequest(config, request.method, request.url);
  if (resolution.statusCode !== 200 || !resolution.filePath) {
    sendStatus(reply, resolution.statusCode);
    return;
  }

  if (!existsSync(resolution.filePath) || !isReadableFile(resolution.filePath)) {
    sendStatus(reply, 404);
    return;
  }

  reply.writeHead(200, {
    'Cache-Control': resolution.cacheControl ?? 'no-store',
    'Content-Type': resolution.contentType ?? 'application/octet-stream',
  });

  if (request.method === 'HEAD') {
    reply.end();
    return;
  }

  const stream = createReadStream(resolution.filePath);
  stream.pipe(reply);
  stream.on('error', () => {
    reply.destroy();
  });
}

export function createHostedServer(config: HostedServerConfig): Server {
  return createServer((request, reply) => {
    sendStaticFile(config, request, reply);
  });
}

export function startHostedServer(
  config = resolveHostedServerConfig()
): Promise<HostedServerHandle> {
  const server = createHostedServer(config);
  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(config.port, config.host, () => {
      server.off('error', rejectStart);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : config.port;
      const urlHost =
        config.host === '0.0.0.0' || config.host === '::' ? DEFAULT_HOST : config.host;
      resolveStart({
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          }),
        port,
        server,
        url: `http://${urlHost}:${port}`,
      });
    });
  });
}

async function runFromEnv(): Promise<void> {
  const handle = await startHostedServer(resolveHostedServerConfig());
  console.log(`Agent Teams hosted startup shell listening at ${handle.url}`);

  const shutdown = (): void => {
    void handle.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  if (process.platform !== 'win32') {
    process.on('SIGTERM', shutdown);
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  void runFromEnv().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Hosted server failed to start');
    process.exit(1);
  });
}
