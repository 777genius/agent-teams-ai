/** TEST-only passive diagnostics for the original source Host on the qualified Node/platform tuples. */
import { channel } from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';

const prefix = 'TEST_OPENCODE_V2_DIAGNOSTIC ';
const maximum = 256;
const events = ['child-spawn', 'child-ready', 'child-failed', 'child-exit', 'child-output-limit',
  'child-input-ended', 'host-input-ended', 'request', 'response', 'response-end', 'request-error', 'trace-limit'] as const;
const routes = ['info', 'session-create', 'session-read', 'instructions', 'permissions', 'plugins',
  'mcp', 'log', 'prompt', 'provider-catalog', 'model-catalog', 'model-default', 'integration-read',
  'integration-connect', 'credential-remove', 'other-api'] as const;
const stages = ['input', 'executable', 'profile', 'graph', 'configuration', 'effect', 'runtime', 'scope', 'server', 'address', 'unknown'] as const;
const codes = ['ABORT_ERR', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT',
  'UND_ERR_ABORTED', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'unknown'] as const;
const signals = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'unknown'] as const;
const contentEncodings = ['none', 'gzip', 'deflate', 'br', 'other'] as const;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const choice = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
  typeof value === 'string' && allowed.includes(value as T) ? value as T : null;
const integer = (value: unknown, max = 3_600_000): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;

/** Project again at the receipt boundary; native text/IDs/credentials are never retained. */
export function createPassiveNativeDiagnosticCapture() {
  const entries: Record<string, unknown>[] = [];
  let pending = '';
  return {
    entries,
    accept(chunk: Buffer, epoch: number) {
      if (entries.length >= maximum + 1 || chunk.length + Buffer.byteLength(pending) > 64 * 1024) { pending = ''; return; }
      pending += chunk.toString('utf8');
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line.startsWith(prefix) || line.length > 512 || entries.length >= maximum + 1) continue;
        try {
          const value = record(JSON.parse(line.slice(prefix.length)) as unknown);
          const event = choice(value.event, events), atMs = integer(value.atMs);
          if (!event || atMs === null) continue;
          entries.push({ epoch, event, atMs, child: integer(value.child, 4), request: integer(value.request, 4096),
            route: choice(value.route, routes), method: choice(value.method, ['GET', 'POST', 'PUT', 'DELETE']),
            durationMs: integer(value.durationMs), status: integer(value.status, 599),
            contentEncoding: choice(value.contentEncoding, contentEncodings),
            stage: choice(value.stage, stages), code: choice(value.code, codes),
            exitCode: integer(value.exitCode, 255), signal: choice(value.signal, signals) });
        } catch { /* Other Host diagnostics are deliberately not retained. */ }
      }
    },
  };
}

/** Classify the pinned Undici Buffer-pair shape; no raw header value is retained. */
function responseContentEncoding(headers: unknown): typeof contentEncodings[number] {
  if (!Array.isArray(headers) || headers.length > 256 || headers.length % 2 !== 0) return 'other';
  let selected: typeof contentEncodings[number] = 'none';
  for (let index = 0; index < headers.length; index += 2) {
    const name = headers[index], value = headers[index + 1];
    if (!Buffer.isBuffer(name)) return 'other';
    if (name.length !== 16 || name.toString('ascii').toLowerCase() !== 'content-encoding') continue;
    if (selected !== 'none' || !Buffer.isBuffer(value) || value.length > 32) return 'other';
    selected = choice(value.toString('ascii').trim().toLowerCase(), ['gzip', 'deflate', 'br']) ?? 'other';
  }
  return selected;
}

function observeOriginalHost(): void {
  const started = performance.now();
  let emitted = 0, children = 0, requests = 0;
  const elapsed = () => Math.max(0, Math.round(performance.now() - started));
  const emit = (value: Record<string, unknown>) => {
    if (emitted > maximum) return;
    process.stderr.write(prefix + JSON.stringify({ atMs: elapsed(),
      ...(emitted++ === maximum ? { event: 'trace-limit' } : value) }) + '\n');
  };
  process.stdin.once('end', () => emit({ event: 'host-input-ended' }));
  const childEntry = fileURLToPath(new URL('../../../dist/adapters/providers/OpenCodeV2EmbeddedChild.js', import.meta.url));
  channel('child_process').subscribe(message => {
    const child = record(message).process as ChildProcess | undefined;
    child?.once('spawn', () => {
      if (child.spawnargs.at(-1) !== childEntry || children >= 4) return;
      const selected = ++children;
      emit({ event: 'child-spawn', child: selected });
      child.stdin?.once('finish', () => emit({ event: 'child-input-ended', child: selected }));
      let output = '', bytes = 0;
      const observe = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) { child.stdout?.off('data', observe); emit({ event: 'child-output-limit', child: selected }); return; }
        output += chunk.toString('utf8');
        for (let end = output.indexOf('\n'); end >= 0; end = output.indexOf('\n')) {
          const line = output.slice(0, end); output = output.slice(end + 1);
          try {
            const value = record(JSON.parse(line) as unknown);
            if (value.type === 'ready' && value.pid === child.pid && value.version === '2.1.4')
              emit({ event: 'child-ready', child: selected });
            else if (value.type === 'failed') emit({ event: 'child-failed', child: selected, stage: choice(value.stage, stages) ?? 'unknown' });
          } catch { /* No raw engine output is retained. */ }
        }
      };
      child.stdout?.on('data', observe);
      child.once('exit', (exitCode, signal) => emit({ event: 'child-exit', child: selected,
        exitCode, signal: signal === null ? null : choice(signal, signals) ?? 'unknown' }));
      child.once('close', () => { child.stdout?.off('data', observe); output = ''; });
    });
  });
  const pending = new WeakMap<object, { request: number; route: string; method: string; started: number }>();
  channel('undici:request:create').subscribe(message => {
    const request = record(record(message).request);
    if (requests >= 4096 || typeof request.origin !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(request.origin) ||
        typeof request.path !== 'string' || !request.path.startsWith('/api/')) return;
    const path = request.path.split('?')[0]!;
    const route = path === '/api/info' ? 'info' : path === '/api/session' ? 'session-create'
      : path === '/api/permission/saved' ? 'permissions' : path === '/api/plugin' ? 'plugins'
      : path === '/api/mcp' ? 'mcp' : /\/instructions?(?:\/|$)/.test(path) ? 'instructions'
      : path === '/api/provider' ? 'provider-catalog' : path === '/api/model' ? 'model-catalog'
      : path === '/api/model/default' ? 'model-default'
      : /^\/api\/integration\/[^/]+\/connect\/key$/.test(path) ? 'integration-connect'
      : /^\/api\/integration\/[^/]+$/.test(path) ? 'integration-read'
      : /^\/api\/credential\/[^/]+$/.test(path) ? 'credential-remove'
      : /\/log$/.test(path) ? 'log' : /\/prompt$/.test(path) ? 'prompt'
      : /^\/api\/session\/[^/]+$/.test(path) ? 'session-read' : 'other-api';
    const method = choice(request.method, ['GET', 'POST', 'PUT', 'DELETE']);
    if (!method) return;
    const value = { request: ++requests, route, method, started: performance.now() };
    pending.set(request, value); emit({ event: 'request', request: value.request, route, method });
  });
  // Headers alone do not show when a finite native log body finishes arriving.
  // Observe only log trailers: no native bytes, header values or new requests.
  channel('undici:request:trailers').subscribe(message => {
    const value = pending.get(record(record(message).request));
    if (value?.route !== 'log') return;
    emit({ event: 'response-end', request: value.request, route: value.route, method: value.method,
      durationMs: Math.max(0, Math.round(performance.now() - value.started)) });
  });
  for (const [name, event] of [['undici:request:headers', 'response'], ['undici:request:error', 'request-error']] as const)
    channel(name).subscribe(message => {
      const row = record(message), value = pending.get(record(row.request));
      if (!value) return;
      emit({ event, request: value.request, route: value.route, method: value.method,
        durationMs: Math.max(0, Math.round(performance.now() - value.started)),
        ...(event === 'response' ? { status: integer(record(row.response).statusCode, 599),
          contentEncoding: responseContentEncoding(record(row.response).headers) }
          : { code: choice(record(row.error).code, codes) ?? 'unknown' }) });
    });
}

// Importing the receipt projection in the parent does not activate an observer.
if ((process.platform === 'linux' && process.arch === 'x64' ||
      (process.platform === 'darwin' || process.platform === 'win32') &&
      (process.arch === 'arm64' || process.arch === 'x64')) && process.version === 'v24.21.0' &&
    process.execArgv.some((argument, index, args) => argument === '--import' &&
      (args[index + 1] === import.meta.url || args[index + 1] === fileURLToPath(import.meta.url))))
  observeOriginalHost();
