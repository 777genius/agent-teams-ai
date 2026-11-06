import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { ClaudeManagementCoordinator } from '../dist/composition/ClaudeManagementCoordinator.js';
import { ClaudeManagementHost } from '../dist/adapters/providers/ClaudeManagementHost.js';
import type { ClaudeManagementProfile } from '../dist/management/profile.js';

async function profile() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-claude-management-host-')));
  for (const name of ['workspace', 'home', 'config']) await mkdir(join(root, name));
  const selected: ClaudeManagementProfile = {
    provider: 'claude', sdkRevision: '0.3.305', profileId: 'TEST-profile', configRevision: 'TEST-config',
    accountBinding: 'TEST-no-auth', configNamespace: 'custom-directory', cwd: join(root, 'workspace'),
    executable: { path: process.execPath, sha256: 'a'.repeat(64) }, timeoutMs: 1000,
    environment: { HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'config'), PATH: '/bin' },
  };
  return { root, selected };
}

test('close caches one owned stop before entering a reentrant custody port', async () => {
  const { root, selected } = await profile();
  try {
    let stops = 0, seals = 0, reentrant: Promise<boolean> | undefined;
    let current!: () => boolean;
    const host: ClaudeManagementHost = new ClaudeManagementHost(selected, () => true, (_profile, canAllocate) => {
      current = canAllocate;
      return {
        launch: () => { throw new Error('No process in this controlled fixture'); },
        seal: () => { if (++seals === 1) reentrant = host.close(); },
        isRunning: () => false,
        confirmStopped: async () => { stops++; return true; },
      };
    });
    const closing = host.close();
    assert.equal(current(), false, 'admission seals synchronously');
    assert.equal(host.close(), closing);
    assert.equal(await closing, true);
    assert.equal(reentrant, closing); assert.equal(stops, 1); assert.equal(seals, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('finite metadata cleanup settles original custody before SDK forwarded abort, including false and throw', async () => {
  for (const mode of ['true', 'false', 'throw'] as const) {
    const { root, selected } = await profile();
    try {
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      const stdio: ChildProcessWithoutNullStreams['stdio'] = [stdin, stdout, stderr, null, null];
      // An unspawned controlled protocol handle: no native process, auth or network.
      const child = Object.assign(new ChildProcess(), { stdin, stdout, stderr, stdio });
      let exitCode: number | null = null;
      Object.defineProperty(child, 'exitCode', { get: () => exitCode });
      let buffer = '', requestSignal: AbortSignal | undefined, stops = 0;
      stdin.on('data', (bytes: Buffer) => {
        buffer += bytes.toString();
        for (;;) {
          const end = buffer.indexOf('\n'); if (end < 0) break;
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line) continue;
          const message: { type?: string; request_id?: string; request?: { subtype?: string } } = JSON.parse(line);
          if (message.type === 'control_request' && message.request?.subtype === 'initialize') {
            stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
              response: { commands: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {} } } }) + '\n');
          }
        }
      });
      let enter!: () => void, finish!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { finish = resolve; });
      const host = new ClaudeManagementHost(selected, () => true, () => ({
        launch: request => { requestSignal = request.signal; return child; },
        seal: () => {}, isRunning: () => false,
        confirmStopped: async () => {
          stops++; assert.equal(requestSignal?.aborted, false); enter(); await gate;
          exitCode = 0; stdout.end(); stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null);
          if (mode === 'throw') throw new Error('TEST-owned stop failed');
          return mode === 'true';
        },
      }));
      const pending = host.read();
      assert.equal(await Promise.race([entered.then(() => 'owner'), pending.then(() => 'published', () => 'failed')]), 'owner');
      const closing = host.close(); assert.equal(host.close(), closing);
      assert.equal(requestSignal?.aborted, false); finish();
      if (mode === 'true') { await pending; assert.equal(await closing, true); }
      else { await assert.rejects(pending, /held/); if (mode === 'false') assert.equal(await closing, false); else await assert.rejects(closing, /TEST-owned stop failed/); }
      assert.equal(stops, 1); assert.equal(requestSignal?.aborted, true);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});


function captureManagementDiagnostics(t: TestContext) {
  const original = process.stderr.write;
  const lines: string[] = [];
  process.stderr.write = function(this: typeof process.stderr, chunk: string | Uint8Array, ...rest: unknown[]) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    if (!text.startsWith('legacy-agent-host: claude-management '))
      return Reflect.apply(original, this, [chunk, ...rest]);
    lines.push(text);
    const callback = rest.at(-1);
    if (typeof callback === 'function') callback();
    return true;
  } as typeof process.stderr.write;
  t.after(() => { process.stderr.write = original; });
  return lines;
}

test('model probe retains normalized pre-mask failure while its public result and owned cleanup remain held/confirmed', async (t) => {
  const lines = captureManagementDiagnostics(t);
  const { root, selected } = await profile();
  try {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const stdio: ChildProcessWithoutNullStreams['stdio'] = [stdin, stdout, stderr, null, null];
    const child = Object.assign(new ChildProcess(), { stdin, stdout, stderr, stdio });
    let exitCode: number | null = null, stops = 0, userInputs = 0;
    Object.defineProperty(child, 'exitCode', { get: () => exitCode });
    let buffer = '';
    stdin.on('data', (bytes: Buffer) => {
      buffer += bytes.toString();
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line) continue;
        const message: { type?: string; request_id?: string; request?: { subtype?: string } } = JSON.parse(line);
        if (message.type === 'user') userInputs++;
        if (message.type === 'control_request' && message.request?.subtype === 'initialize')
          stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
            response: { commands: [], output_style: 'default', available_output_styles: ['default'], account: {},
              models: [{ value: 'opus', resolvedModel: 'TEST-opus', supportedEffortLevels: [] }] } } }) + '\n');
      }
    });
    const host = new ClaudeManagementHost(selected, () => true, () => ({
      launch: () => child, seal: () => {}, isRunning: () => false,
      confirmStopped: async () => {
        stops++; exitCode = 0; stdout.end(); stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null);
        return true;
      },
    }));
    await assert.rejects(host.probe('opus', new AbortController().signal, { effort: 'medium' }), { code: 'held' });
    assert.equal(stops, 1); assert.equal(await host.close(), true); assert.equal(userInputs, 0);
    const observed = lines.map(line => JSON.parse(line.slice('legacy-agent-host: claude-management '.length)) as { stage: string; code: string });
    assert.ok(observed.some(value => value.stage === 'host-probe' && value.code === 'claude.probe.invalid-response'));
    assert.equal(lines.join('').includes(root), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('coordinator current guard is observed before Host creation without changing its error or cleanup', async (t) => {
  const lines = captureManagementDiagnostics(t);
  const { root, selected } = await profile();
  try {
    const coordinator = new ClaudeManagementCoordinator([selected], () => {});
    const probe = coordinator.prepareProbe({ profileId: selected.profileId, configRevision: selected.configRevision,
      commandId: 'TEST-original-command', providerId: 'anthropic', modelId: 'opus' }, () => false);
    await assert.rejects(probe.run(new AbortController().signal), { code: 'held' });
    assert.equal(await probe.close(), true);
    assert.equal(lines.length, 1);
    const observed = JSON.parse(lines[0]!.slice('legacy-agent-host: claude-management '.length)) as { stage: string; code: string; commandHash: string };
    assert.equal(observed.stage, 'probe-current'); assert.equal(observed.code, 'management.held');
    assert.match(observed.commandHash, /^[a-f0-9]{64}$/);
    assert.equal(lines.join('').includes('TEST-original-command'), false);
    await coordinator.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
