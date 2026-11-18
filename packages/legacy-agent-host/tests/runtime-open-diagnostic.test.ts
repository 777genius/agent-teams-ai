import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { createRuntimeMemberProviderFactory } from '../dist/composition/createRuntimeMemberProviderFactory.js';
import { createTeamHost } from '../dist/composition/TeamHost.js';
import { RuntimeOwnerError } from '../dist/runtime/contracts.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';

import type { MemberProvider, MemberProviderContext } from '../dist/adapters/providers/MemberProvider.js';
import type { MemberEntry } from '../dist/composition/MemberEntry.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { RuntimeBinding } from '../dist/runtime/contracts.js';
import type { DriverFactory, OpenConfig, Session } from '@agent-teams/provider-session-contracts';
import type { TestContext } from 'node:test';

const diagnosticPrefix = 'legacy-agent-host: runtime-open ';
const binding: RuntimeBinding = {
  backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-run',
  memberId: 'alice-id', generation: '1',
};
const config: OpenConfig = {
  tenantId: 'TEST-backend', projectId: 'TEST-project', sessionId: 'TEST-private-session',
  generation: 1, configRevision: 'TEST-private-revision', requiredCapabilities: ['tools'],
};
function capture(t: TestContext, event?: (record: Record<string, unknown>) => void) {
  const records: Record<string, unknown>[] = [];
  const original = process.stderr.write;
  t.mock.method(process.stderr, 'write', function (
    this: NodeJS.WriteStream, ...args: Parameters<NodeJS.WriteStream['write']>
  ) {
    const text = Buffer.isBuffer(args[0]) ? args[0].toString('utf8') : String(args[0]);
    if (!text.startsWith(diagnosticPrefix)) return original.apply(this, args);
    const record = JSON.parse(text.slice(diagnosticPrefix.length)) as Record<string, unknown>;
    records.push(record);
    event?.(record);
    const callback = args.find(value => typeof value === 'function');
    if (typeof callback === 'function') callback();
    return true;
  });
  return records;
}
function session(): Session {
  let end!: () => void;
  const ended = new Promise<void>(resolve => { end = resolve; });
  const driver: Session = {
    sessionRef: 'TEST-private-native-session',
    submit: async () => ({ ok: false, code: 'unsupported' }),
    observe: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => { await ended; return { done: true, value: undefined }; },
      }),
    }),
    respondToInteraction: async () => ({ ok: false, code: 'unsupported' }),
    interrupt: async () => ({ ok: false, code: 'unsupported' }),
    checkReadiness: async function () {
      assert.equal(this, driver);
      return { ok: true, value: undefined };
    },
    checkpoint: () => ({ ok: false, code: 'unsupported' }),
    close: async function () {
      assert.equal(this, driver);
      end();
      return { logicallyClosed: true, cleanup: 'confirmed' };
    },
  };
  return driver;
}
async function owner(t: TestContext, factory: DriverFactory) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-runtime-open-diagnostic-')));
  const runtime = new RuntimeOwner({
    store: new FileRuntimeStore(root), driverFactory: factory, profileId: 'TEST-private-profile',
    hostIncarnation: 'TEST-host', authorize: () => true,
  });
  t.after(async () => {
    await runtime.stopSession(binding);
    await rm(root, { recursive: true, force: true });
  });
  return runtime;
}

test('actual Runtime keeps a failed finite driver open held with the original configuration', async t => {
  const records = capture(t), original = new RuntimeOwnerError('forbidden');
  let calls = 0;
  const factory: DriverFactory = { open: async function () {
    assert.equal(this, factory); calls++; throw original;
  } };
  const runtime = await owner(t, factory);
  const record = await runtime.openSession({ binding, config });
  assert.equal(calls, 1);
  assert.equal(record.phase, 'held'); assert.equal(record.custody, 'unknown');
  assert.equal(record.nativeReady, false); assert.equal(record.diagnostic, 'open-unknown');
  assert.deepEqual(record.config, config);
  assert.equal(runtime.readCapturedSession(binding).attached, false);
  assert.equal(records.length, 1);
  assert.deepEqual(
    { source: records[0]!.source, phase: records[0]!.phase, category: records[0]!.category },
    { source: 'runtime', phase: 'driver-open', category: 'forbidden' }
  );
  assert.equal(records[0]!.configurationHash, runtimeDigest(config));
  assert.equal(JSON.stringify(records).includes(config.sessionId), false);
});

test('actual Runtime distinguishes a readiness throw after the finite driver was attached', async t => {
  const records = capture(t), driver = session();
  driver.checkReadiness = async function () {
    assert.equal(this, driver); throw new RuntimeOwnerError('busy');
  };
  const runtime = await owner(t, { open: async () => ({ driver, capabilities: ['tools'] }) });
  const record = await runtime.openSession({ binding, config });
  assert.equal(record.phase, 'held'); assert.equal(record.custody, 'unknown');
  assert.equal(record.nativeReady, false); assert.equal(record.diagnostic, 'open-unknown');
  assert.equal(runtime.readCapturedSession(binding).attached, true);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.phase, 'readiness'); assert.equal(records[0]!.category, 'busy');
});

test('actual Runtime success and its original finite close emit no refusal', async t => {
  const records = capture(t), driver = session();
  const runtime = await owner(t, { open: async () => ({ driver, capabilities: ['tools'] }) });
  const record = await runtime.openSession({ binding, config });
  assert.equal(record.phase, 'allocated'); assert.equal(record.nativeReady, true);
  const closed = await runtime.stopSession(binding);
  assert.equal(closed.phase, 'closed'); assert.equal(closed.custody, 'released');
  assert.deepEqual(records, []);
});

test('factory selection rethrows the exact original exception without attempting later ports', async t => {
  const records = capture(t), original = new RuntimeOwnerError('forbidden');
  const entry = { config } as MemberEntry;
  const options = {
    entries: new Map([['TEST-entry', entry]]), profileId: 'TEST-private-profile',
    isSealed: () => { throw original; },
  } as Parameters<typeof createRuntimeMemberProviderFactory>[0];
  const factory = createRuntimeMemberProviderFactory(options);
  await assert.rejects(factory.open(config, () => {}), error => error === original);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.source, 'factory');
  assert.equal(records[0]!.phase, 'selection'); assert.equal(records[0]!.category, 'forbidden');
});

function profile(root: string): TeamHostProfile {
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-runtime-host' };
  return {
    schemaVersion: 1,
    owner: {
      ownerId: binding.backendId,
      revision: 'revision-1',
      storageRoot: root,
      profileId: 'TEST-profile',
      protocolVersion: 1,
      buildId: 'TEST-runtime-team-host',
      nodeSha256: 'a'.repeat(64),
      hostEntrySha256: 'b'.repeat(64),
    },
    principalId: 'human',
    teams: [
      {
        binding,
        scope: {
          projectId: 'TEST-project',
          workspaceId: 'TEST-workspace',
          teamId: binding.teamId,
          runId: 'TEST-run',
          memberId: 'human',
          generation: '1',
        },
        members: [
          {
            memberId: 'alice-id',
            name: 'alice',
            role: 'member',
            delivery: { ...binding, runId: 'TEST-run', memberId: 'alice-id', generation: '1' },
          },
          { memberId: 'bob-id', name: 'bob', role: 'member' },
        ],
        grants: [
          {
            principalId: 'human',
            memberName: 'user',
            permissions: ['read', 'task.write', 'message.write', 'admin'],
          },
          {
            principalId: 'alice-session',
            memberName: 'alice',
            permissions: ['read', 'task.write', 'message.write'],
          },
        ],
      },
    ],
    runtime: {
      members: [
        {
          teamId: binding.teamId,
          memberId: 'alice-id',
          principalId: 'alice-session',
          provider: 'claude',
          sessionId: 'PRIVATE-config-session',
          generation: 1,
          configRevision: 'PRIVATE-config-revision',
          cwd: root,
          model: 'PRIVATE-model',
          accountBinding: 'PRIVATE-account',
          environment: { HOME: root, PATH: '/TEST/no-native-execution', CLAUDE_CONFIG_DIR: root, TEST_TOKEN: 'PRIVATE-environment-token' },
          executable: { path: '/TEST/nonexistent-no-execution', sha256: 'c'.repeat(64) },
          nativeTools: [],
          autoAllowedTools: [],
          limits: {
            queuedInputs: 8,
            inputBytes: 65536,
            outputBytes: 65536,
            outputEvents: 256,
            pendingInteractions: 8,
            timeoutMs: 1000,
          },
        },
      ],
    },
  };
}


async function composedHost(t: TestContext, action: (context: MemberProviderContext) => Promise<Awaited<ReturnType<DriverFactory['open']>>>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-factory-open-diagnostic-')));
  const selected = profile(root), input = new PassThrough(), output = new PassThrough();
  const replies = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  let pending = '', sequence = 0, providerCalls = 0;
  output.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const frame = JSON.parse(pending.slice(0, newline)) as {
        id?: number; result?: unknown; error?: unknown;
      };
      pending = pending.slice(newline + 1);
      if (frame.id === undefined) continue;
      const reply = replies.get(frame.id);
      if (!reply) continue;
      replies.delete(frame.id);
      if (frame.error !== undefined) reply.reject(frame.error);
      else reply.resolve(frame.result);
    }
  });
  const host = createTeamHost(selected, { input, output }, {
    createProvider(context): MemberProvider {
      providerCalls++;
      const provider: MemberProvider = {
        factory: { open: async function (request) {
          assert.equal(this, provider.factory); assert.equal(request, context.request);
          return action(context);
        } },
        isReady: () => false, seal: () => {}, cleanup: async () => true,
      };
      return provider;
    },
  });
  t.after(async () => {
    try { await host.dispose(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  function rpc(method: string, params: unknown): Promise<unknown> {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      replies.set(id, { resolve, reject });
      input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  await rpc('host.handshake', { protocolVersion: 1 });
  const open = () => rpc('runtime.open', {
    commandId: 'TEST-original-open',
    binding: { schemaVersion: 1, handleId: 'TEST-handle',
      owner: selected.owner, scope: selected.teams[0]!.scope },
    payload: { memberId: 'alice-id' },
  });
  return { open, providerCalls: () => providerCalls, root };
}

for (const cleanupFailure of [false, true]) {
  test('real composition keeps the first factory refusal before endpoint close; cleanup failure=' + cleanupFailure,
    { timeout: 30_000 }, async t => {
      const order: string[] = [];
      const records = capture(t, record => { order.push(String(record.source) + ':' + String(record.phase)); });
      const cleanupError = new RuntimeOwnerError('busy');
      const originalClose = Server.prototype.close;
      t.mock.method(Server.prototype, 'close', function (
        this: Server, callback?: (error?: Error) => void
      ) {
        order.push('endpoint-close');
        return originalClose.call(this, (error?: Error) => {
          callback?.(error ?? (cleanupFailure ? cleanupError : undefined));
        });
      });
      const original = new RuntimeOwnerError('forbidden');
      const f = await composedHost(t, async () => { order.push('native-open'); throw original; });
      await f.open();
      assert.equal(f.providerCalls(), 1);
      const factory = records.filter(row => row.source === 'factory');
      const runtime = records.filter(row => row.source === 'runtime');
      assert.equal(factory.length, 1, 'cleanup cannot replace or repeat the first factory refusal');
      assert.equal(factory[0]!.phase, 'driver-open'); assert.equal(factory[0]!.category, 'forbidden');
      assert.equal(runtime.length, 1); assert.equal(runtime[0]!.phase, 'driver-open');
      assert.equal(runtime[0]!.category, cleanupFailure ? 'busy' : 'forbidden',
        'the original endpoint-close failure still takes precedence in the outer Runtime catch');
      assert.equal(factory[0]!.configurationHash, runtime[0]!.configurationHash);
      assert.ok(order.indexOf('native-open') < order.indexOf('factory:driver-open'));
      assert.ok(order.indexOf('factory:driver-open') < order.indexOf('endpoint-close'));
      assert.ok(order.indexOf('endpoint-close') < order.indexOf('runtime:driver-open'));
      const state = new FileRuntimeStore(f.root).fenced(binding, tx => tx.get());
      assert.equal(state?.phase, 'held'); assert.equal(state?.custody, 'unknown');
      assert.equal(state?.diagnostic, 'open-unknown');
      assert.equal(JSON.stringify(records).includes('PRIVATE-'), false);
    });
}

test('real composition with a finite successful driver does not manufacture a refusal',
  { timeout: 30_000 }, async t => {
    const records = capture(t), driver = session();
    const f = await composedHost(t, async context => ({
      driver, capabilities: [...context.request.requiredCapabilities],
    }));
    const result = await f.open() as { ok: boolean };
    assert.equal(result.ok, true); assert.equal(f.providerCalls(), 1);
    const state = new FileRuntimeStore(f.root).fenced(binding, tx => tx.get());
    assert.equal(state?.phase, 'allocated'); assert.equal(state?.nativeReady, true);
    assert.deepEqual(records, []);
  });
