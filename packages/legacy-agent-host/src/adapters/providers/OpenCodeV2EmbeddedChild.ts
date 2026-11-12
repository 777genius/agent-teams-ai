import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyOpenCodeV2EmbeddedGraph } from './OpenCodeV2EmbeddedGraph.js';
import { bindOpenCodeV2ConfiguredPackages } from './OpenCodeV2ConfiguredPackages.js';

import type { OpenCodeV2EmbeddedSelection } from './OpenCodeV2EmbeddedGraph.js';

// One dedicated child. Credentials and configuration arrive only on its original
// private stdin; engine diagnostics are never copied into Host logs or receipts.
const frameWrite = process.stdout.write.bind(process.stdout);
const discardWrite = (_chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
  const complete = typeof encoding === 'function' ? encoding : callback;
  if (typeof complete === 'function') queueMicrotask(() => complete());
  return true;
};
process.stdout.write = discardWrite;
process.stderr.write = discardWrite;
const controller = new AbortController();
let nonce: string | undefined;
let stage = 'input';
let startup: Promise<void> | undefined;
let finalize: (() => Promise<void>) | undefined;
let closing: Promise<void> | undefined;
let received = false;
let failureReported = false;
let buffer = Buffer.alloc(0);
const fail = (): never => {
  throw new Error('OpenCode V2 embedded child unavailable');
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
};
function frame(value: Readonly<Record<string, unknown>>): void {
  frameWrite(`\n${JSON.stringify(value)}\n`);
}
function close(): Promise<void> {
  return (closing ??= (async () => {
    controller.abort();
    clearTimeout(watchdog);
    const deadline = setTimeout(() => process.exit(1), 4000);
    try {
      await startup?.catch(() => undefined);
      await finalize?.();
      clearTimeout(deadline);
      process.exit(0);
    } catch {
      process.exit(1);
    }
  })());
}
function failed(): void {
  if (!failureReported) {
    failureReported = true;
    frame({ type: 'failed', stage, ...(nonce ? { nonce } : {}) });
  }
  void close();
}
const watchdog = setTimeout(failed, 180_000);
process.stdin.once('end', () => {
  void close();
});
process.stdin.once('error', failed);
process.stdout.once('error', () => {
  void close();
});
process.once('SIGTERM', () => {
  void close();
});
process.once('SIGINT', () => {
  void close();
});
process.once('uncaughtException', failed);
process.once('unhandledRejection', failed);

interface EffectRuntime {
  Effect: {
    runPromise<A>(effect: unknown, options?: { signal: AbortSignal }): Promise<A>;
    provideService(tag: unknown, value: unknown): (effect: unknown) => unknown;
  };
  Scope: { make(): unknown; close(scope: unknown, exit: unknown): unknown; Scope: unknown };
  Exit: { void: unknown };
}
interface EngineRuntime {
  start(options: unknown): { pipe(map: (effect: unknown) => unknown): unknown };
}

async function canonicalDirectory(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !path.isAbsolute(value) || (await realpath(value)) !== value)
    return fail();
  const info = await lstat(value);
  if (!info.isDirectory() || info.isSymbolicLink()) return fail();
  return value;
}

async function start(value: unknown): Promise<void> {
  const input = record(value);
  if (
    typeof input.nonce !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.nonce) ||
    typeof input.password !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.password) ||
    !Number.isSafeInteger(input.port) ||
    Number(input.port) < 0 ||
    Number(input.port) > 65535
  )
    return fail();
  nonce = input.nonce;
  stage = 'executable';
  const executable = record(input.executable);
  if (
    typeof executable.path !== 'string' ||
    typeof executable.sha256 !== 'string' ||
    (await realpath(process.execPath)) !== executable.path ||
    createHash('sha256')
      .update(await readFile(process.execPath))
      .digest('hex') !== executable.sha256
  )
    return fail();
  stage = 'profile';
  const cwd = await canonicalDirectory(input.cwd);
  const configDirectory = await canonicalDirectory(input.configDirectory);
  if (
    cwd !== process.cwd() ||
    typeof input.databasePath !== 'string' ||
    !path.isAbsolute(input.databasePath)
  )
    return fail();
  await canonicalDirectory(path.dirname(input.databasePath));
  const config = record(input.config);
  if (config.plugin !== undefined) return fail();
  stage = 'graph';
  const graph = await verifyOpenCodeV2EmbeddedGraph(
    record(input.embedded) as unknown as OpenCodeV2EmbeddedSelection,
    controller.signal
  );
  if (process.versions.bun !== graph.requiredBunVersion) return fail();
  controller.signal.throwIfAborted();
  stage = 'configuration';
  const nativeConfig = await bindOpenCodeV2ConfiguredPackages(config, graph);
  controller.signal.throwIfAborted();
  stage = 'effect';
  const { Effect, Scope, Exit } = (await import(
    pathToFileURL(graph.effectPath).href
  )) as EffectRuntime;
  stage = 'runtime';
  const runtime = (await import(pathToFileURL(graph.modulePath).href)) as EngineRuntime;
  controller.signal.throwIfAborted();
  stage = 'scope';
  const scope = await Effect.runPromise(Scope.make());
  finalize = () => Effect.runPromise<void>(Scope.close(scope, Exit.void));
  controller.signal.throwIfAborted();
  stage = 'server';
  const server = await Effect.runPromise<{ address: unknown }>(
    runtime
      .start({
        hostname: '127.0.0.1',
        port: Number(input.port),
        password: input.password,
        app: { name: 'agent-teams-stage1-host', version: '2.1.4' },
        database: { path: input.databasePath },
        events: { persist: true },
        config: { directory: configDirectory, project: false, content: JSON.stringify(nativeConfig) },
        models: { fetch: false, snapshot: true },
        fs: { filewatcher: false, fff: false },
      })
      .pipe(Effect.provideService(Scope.Scope, scope)),
    { signal: controller.signal }
  );
  controller.signal.throwIfAborted();
  stage = 'address';
  const address = record(server.address);
  const ip = record(address.address);
  if (
    address._tag !== 'InetAddressV4' ||
    ip._tag !== 'Ipv4Address' ||
    String(address.address) !== '127.0.0.1' ||
    !Number.isSafeInteger(address.port) ||
    Number(address.port) < 1 ||
    Number(address.port) > 65535
  )
    return fail();
  clearTimeout(watchdog);
  frame({
    type: 'ready',
    nonce,
    pid: process.pid,
    version: '2.1.4',
    endpoint: `http://127.0.0.1:${address.port}`,
  });
}

process.stdin.on('data', (chunk: Buffer) => {
  if (received || buffer.length + chunk.length > 256 * 1024) {
    failed();
    return;
  }
  buffer = Buffer.concat([buffer, chunk]);
  const newline = buffer.indexOf(10);
  if (newline < 0) return;
  received = true;
  if (newline !== buffer.length - 1) {
    failed();
    return;
  }
  try {
    const input: unknown = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
    buffer = Buffer.alloc(0);
    startup = start(input);
    void startup.catch(failed);
  } catch {
    failed();
  }
});
