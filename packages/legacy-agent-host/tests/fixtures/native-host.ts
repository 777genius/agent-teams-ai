import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

export const fileHash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
export const tick = () => new Promise<void>((done) => setTimeout(done, 25));
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function assertSafeRuntimeProjection(value: unknown): void {
  const safe = record(value);
  assert.ok(
    Object.keys(safe).every((key) =>
      [
        'memberId',
        'generation',
        'phase',
        'sealed',
        'custody',
        'nativeReady',
        'attached',
        'inputs',
        'interactions',
        'diagnostic',
        'attachmentCapabilities',
      ].includes(key)
    ),
    'runtime RPC exposes only its explicit safe projection'
  );
  assert.ok(
    (safe.inputs as unknown[])
      .map(record)
      .every((input) =>
        Object.keys(input).every((key) => ['inputId', 'phase', 'terminal'].includes(key))
      )
  );
  if (Object.hasOwn(safe, 'attachmentCapabilities')) {
    const capabilities = record(safe.attachmentCapabilities);
    assert.deepEqual(Object.keys(capabilities).sort(), ['documents', 'images', 'textFiles']);
    assert.ok(Object.values(capabilities).every((value) => typeof value === 'boolean'));
  }
  assert.equal(JSON.stringify(safe).includes('Bearer '), false);
}

// Pins the complete compiled/source host, including transitive composition changes.
// Sorted relative path + NUL + exact file bytes + NUL, recursively for .js/.ts.
export async function treeHash(root: string, suffix: string): Promise<string> {
  async function paths(directory: string, prefix = ''): Promise<string[]> {
    const result: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory())
        result.push(...(await paths(join(directory, entry.name), relative + '/')));
      else if (entry.isFile() && entry.name.endsWith(suffix)) result.push(relative);
    }
    return result;
  }
  const digest = createHash('sha256');
  for (const path of (await paths(root)).sort())
    digest
      .update(path)
      .update('\0')
      .update(await readFile(join(root, path)))
      .update('\0');
  return digest.digest('hex');
}

export function startHost(options: {
  node: string;
  entry: string;
  root: string;
  profile: string;
  profileHash: string;
  onDiagnostic?(chunk: Buffer): void;
  onNotification?(method: string, params: unknown): void;
}) {
  const child = spawn(options.node, [options.entry], {
    cwd: options.root,
    env: {
      HOME: join(options.root, 'home'),
      TMPDIR: join(options.root, 'tmp'),
      PATH: `${dirname(options.node)}:/usr/bin:/bin`,
      LEGACY_AGENT_HOST_PROFILE_PATH: options.profile,
      LEGACY_AGENT_HOST_PROFILE_SHA256: options.profileHash,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  const frameFacts: { id: number; method: string; ok: boolean }[] = [];
  let nextId = 0;
  let stdoutValid = true;
  let diagnosticBytes = 0;
  let exited = false;
  const rejectPending = (message: string) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    pending.clear();
  };
  const exit = new Promise<void>((done) => {
    child.once('exit', () => {
      exited = true;
      rejectPending('Host exited; original intent retained');
      done();
    });
    child.once('error', () => {
      exited = true;
      rejectPending('Host unavailable; original intent retained');
      done();
    });
  });
  child.stdin.on('error', () => rejectPending('Host stdin unavailable; original intent retained'));
  child.stderr.on('data', (chunk: Buffer) => {
    diagnosticBytes += chunk.length;
    options.onDiagnostic?.(chunk);
  });
  lines.on('line', (line) => {
    try {
      assert.ok(Buffer.byteLength(line) < 256 * 1024);
      const frame = record(JSON.parse(line) as unknown);
      assert.equal(frame.jsonrpc, '2.0');
      if (frame.id === undefined && typeof frame.method === 'string') {
        options.onNotification?.(frame.method, frame.params);
        return;
      }
      assert.equal(typeof frame.id, 'number');
      const waiter = pending.get(Number(frame.id));
      assert.ok(waiter, 'one answer for a test-owned RPC request');
      pending.delete(Number(frame.id));
      clearTimeout(waiter.timer);
      if (frame.error) waiter.reject(new Error('Host returned RPC protocol error'));
      else waiter.resolve(frame.result);
    } catch {
      stdoutValid = false;
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Host stdout protocol violation'));
      }
      pending.clear();
    }
  });
  async function waitExit(timeout: number) {
    const end = Date.now() + timeout;
    while (!exited && Date.now() < end) await tick();
    return exited;
  }
  return {
    child,
    async rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
      assert.ok(!exited && stdoutValid);
      const id = ++nextId;
      const response = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Host RPC ${method} exceeded 60 seconds; intent retained`));
        }, 60_000);
        pending.set(id, { resolve, reject, timer });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const result = record(await response);
      if (method.startsWith('runtime.activity.') && result.ok === true) {
        const safe = record(result.value);
        assert.ok(
          Object.keys(safe).every((key) =>
            [
              'memberId',
              'cursor',
              'retainedFrom',
              'events',
              'hasMore',
              'gap',
              'state',
              'latest',
            ].includes(key)
          )
        );
        assert.equal(typeof safe.cursor, 'string');
        const serialized = JSON.stringify(safe);
        assert.equal(serialized.includes('operationRef'), false);
        assert.equal(serialized.includes('Bearer '), false);
      } else if (method === 'runtime.checkpoint' && result.ok === true) {
        const safe = record(result.value);
        assert.ok(
          Object.keys(safe).every((key) => ['checkpointId', 'status', 'reference'].includes(key))
        );
        assert.equal(typeof safe.checkpointId, 'string');
        assert.ok(['published', 'unsupported', 'held'].includes(String(safe.status)));
        if (safe.status === 'published') assert.match(String(safe.reference), /^cp1-[a-f0-9]{64}$/);
      } else if (method.startsWith('runtime.') && result.ok === true) {
        assertSafeRuntimeProjection(result.value);
      }
      frameFacts.push({ id, method, ok: result.ok !== false });
      return result;
    },
    async close() {
      child.stdin.end();
      if (!(await waitExit(12_000))) {
        child.kill('SIGTERM');
        assert.ok(
          await waitExit(12_000),
          'captured Host must confirm provider cleanup before exiting'
        );
      }
      await exit;
      lines.close();
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Host closed'));
      }
      pending.clear();
      assert.equal(child.exitCode, 0, 'Host exit zero confirms Runtime/provider cleanup completed');
      assert.equal(child.signalCode, null);
      assert.equal(stdoutValid, true);
    },
    facts: () => ({
      pid: child.pid,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      stdoutValid,
      diagnosticBytes,
      frames: frameFacts,
    }),
  };
}
