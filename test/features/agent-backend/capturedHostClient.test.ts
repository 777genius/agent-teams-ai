// @vitest-environment node
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RetainedWindowsCustody } from '@agent-teams/legacy-agent-host/owned-process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { assertDesktopMetadataLineageReleased, desktopMetadataProfileHash,
  readDesktopMetadataLineage } from '../../../scripts/legacy-agent-host/desktop-opencode-metadata-lineage';
import {
  type CapturedHostClient,
  createCapturedHostClient,
  type SelectedHostProfile,
} from '../../../src/features/agent-backend/main';
import { capturedHostProfileDigest } from '../../../src/features/agent-backend/main/infrastructure/selectedHostProfile';
import { formatPersistentLogMessage, installPersistentAppLog } from '../../../src/main/utils/persistentAppLog';
import { addLogSink } from '../../../src/shared/utils/logger';

import {
  retainedNativeHostSource,
  retainedNativeInputCompletionGate,
  retainedNativeInputPressureHostSource,
  retainedNativePayloadDigest,
  retainedNativePressureHostSource,
  retainedNativePressurePrimitive,
  retainedNativePrimitive,
} from './fixtures/retainedNativeCustody';

import type {
  HostCustodyBinding,
  HostCustodyHint,
  HostCustodyOwner,
  HostCustodyResult,
} from '@agent-teams/legacy-agent-host/owned-process';

let nodeExecutable: string;
let nodeVersion: string;
let nodeSha256: string;
let serverUrl: string;
let cliUrl: string;
const roots: string[] = [];
const clients: CapturedHostClient[] = [];
const unrelatedChildren: ChildProcess[] = [];

beforeAll(async () => {
  nodeExecutable = await realpath(process.env.AGENT_BACKEND_TEST_NODE ?? process.execPath);
  nodeVersion = execFileSync(nodeExecutable, ['--version'], { env: {}, encoding: 'utf8' }).trim();
  nodeSha256 = createHash('sha256')
    .update(await readFile(nodeExecutable))
    .digest('hex');
  serverUrl = execFileSync(
    nodeExecutable,
    [
      '--input-type=module',
      '-e',
      'process.stdout.write(import.meta.resolve("@agent-teams/legacy-agent-host"))',
    ],
    { cwd: process.cwd(), env: {}, encoding: 'utf8' }
  );
  cliUrl = execFileSync(
    nodeExecutable,
    [
      '--input-type=module',
      '-e',
      'process.stdout.write(import.meta.resolve("@agent-teams/legacy-agent-host/cli"))',
    ],
    { cwd: process.cwd(), env: {}, encoding: 'utf8' }
  );
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.shutdown()));
  await Promise.all(
    unrelatedChildren.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          child.once('close', () => resolve());
          child.kill();
        })
    )
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  body = '',
  mode: 'server' | 'raw' = 'server',
  nativeOptions = ''
): Promise<SelectedHostProfile> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-agent-backend-')));
  roots.push(root);
  const hostEntry = join(root, 'host.mts');
  const source =
    mode === 'raw'
      ? body
      : `
    import { createHostServer } from ${JSON.stringify(serverUrl)};
    import { appendFileSync } from 'node:fs';
    const server = createHostServer({ input: process.stdin, output: process.stdout,
      buildId: 'TEST-host-v1',
      ${nativeOptions}
      methods: {
        echo: { lane: 'work', handle: (params) => params },
        loss: { lane: 'work', handle: () => { appendFileSync(${JSON.stringify(join(root, 'effects'))}, 'effect\\n'); process.exit(0); } },
        failure: { lane: 'work', handle: () => { appendFileSync(${JSON.stringify(join(root, 'effects'))}, 'effect\\n'); throw new Error('private payload must stay private'); } },
        hold: { lane: 'work', handle: () => new Promise(() => {}) },
        control: { lane: 'control', handle: () => 'control-progress' },
        notify: { lane: 'work', handle: () => { for (let i = 0; i < 200; i++) server.notifyData('event', { i }); return 'done'; } },
        ${body}
      }
    });
    void server.closed.then(() => process.exit(0));
  `;
  await writeFile(hostEntry, source);
  return {
    profileId: 'TEST-profile',
    nodeExecutable,
    nodeVersion,
    nodeSha256,
    hostEntry,
    hostEntrySha256: createHash('sha256').update(source).digest('hex'),
    expectedBuildId: 'TEST-host-v1',
    cwd: root,
    env: { HOME: root, TMPDIR: root },
    startupTimeoutMs: 3000,
    requestTimeoutMs: 500,
    writeTimeoutMs: 500,
    shutdownTimeoutMs: 100,
  };
}

function client(profile: SelectedHostProfile, owner?: HostCustodyOwner): CapturedHostClient {
  const instance = createCapturedHostClient(profile, owner);
  clients.push(instance);
  return instance;
}

describe('captured legacy host client over real subprocess stdio', () => {
  it.each(['graceful', 'crash'] as const)('retains Main launch/stdio/receipt ownership across %s Host close', async mode => {
    const profile = { ...await fixture(retainedNativeHostSource(serverUrl), 'raw'), requestTimeoutMs: 3000 };
    const primitive = retainedNativePrimitive();
    let current = true, verified = 0;
    const owner = new RetainedWindowsCustody({ profileId: profile.profileId,
      profileDigest: capturedHostProfileDigest(profile),
      selectBroker: () => ({ path:'C:\\TEST\\owned-process-broker.exe', sha256:'2'.repeat(64), arch:'x64', protocol:1 }),
      async verifyLaunch() { expect(current).toBe(true); verified++; },
      createPort: () => primitive.port });
    const original = client(profile, owner);
    try {
      await original.start();
      expect(await original.request('launch')).toEqual({ bytes:131072, sha256:retainedNativePayloadDigest });
      expect(verified).toBe(2);
      expect(Buffer.concat(primitive.writes).byteLength).toBe(131072);
      primitive.rootExit();
      await expect.poll(() => original.request('state')).toEqual({ exitCode:0, stdoutEnded:false });
      expect(primitive.calls.stopped).toBe(0);
      if (mode === 'crash') {
        await expect(original.request('crash')).rejects.toMatchObject({ outcome:'unknown' });
        expect((await original.shutdown()).childExit).toBe('confirmed');
        expect(primitive.calls.stopped).toBe(0);
        current = false; // Changed source cannot discard the retained original cleanup authority.
      } else {
        expect((await original.shutdown()).childExit).toBe('confirmed');
        expect(primitive.calls.stopped).toBe(1);
        expect(primitive.calls.released).toBe(1);
      }
      expect(await owner.close()).toBe(true);
      expect(primitive.calls).toEqual({ allocated:1, prepared:1, resumed:1, stopped:1, released:1 });
    } finally { await original.shutdown(); await owner.close(); }
  });

  it.each(['graceful', 'expired'] as const)('queues multi-member launch and %s cleanup without caching capacity refusals', async mode => {
    const profile = { ...await fixture(retainedNativePressureHostSource(serverUrl), 'raw'),
      requestTimeoutMs: 3000 };
    const primitive = retainedNativePressurePrimitive();
    const owner = new RetainedWindowsCustody({ profileId: profile.profileId,
      profileDigest: capturedHostProfileDigest(profile),
      selectBroker: () => ({ path:'C:\\TEST\\owned-process-broker.exe', sha256:'2'.repeat(64), arch:'x64', protocol:1 }),
      async verifyLaunch() {}, createPort: () => primitive.port });
    const original = client(profile, owner);
    try {
      await original.start();
      const launching = original.request('launch');
      await Promise.race([primitive.workFull, launching.then(() => {
        throw new Error('TEST launch crossed an unreleased preparation barrier');
      })]);
      expect(primitive.calls.prepared).toBe(24);
      primitive.releaseWork();
      expect(await launching).toBe(48);
      expect(primitive.calls).toMatchObject({ allocated:48, prepared:48, resumed:48, written:48 });
      const closing = mode === 'graceful' ? original.shutdown()
        : original.request('holdCloses', undefined, { control:true });
      await Promise.race([primitive.controlFull, closing.then(() => {
        throw new Error('TEST close crossed an unreleased original Stop barrier');
      })]);
      expect(primitive.calls.stopped).toBe(32);
      if (mode === 'expired') {
        expect(await original.request('expireOne', undefined, { control:true })).toBe('unknown');
        expect(primitive.calls.stopped, 'Expired queued Stop never reached the original primitive').toBe(32);
      }
      primitive.releaseControl();
      if (mode === 'expired') {
        expect(await closing).toBe(32);
        expect(await original.request('finishExplicit', undefined, { control:true }))
          .toEqual({ count:48, originalExpired:'unknown' });
      }
      expect((await original.shutdown()).childExit).toBe('confirmed');
      expect(await owner.close()).toBe(true);
      expect(primitive.calls).toEqual({ allocated:48, prepared:48, resumed:48,
        written:48, stopped:48, released:48 });
    } finally {
      primitive.releaseWork(); primitive.releaseControl();
      await original.shutdown(); await owner.close();
    }
  });

  it.each([false, true])('holds Main reply bytes before native effect, expiry=%s', async expire => {
    const profile = { ...await fixture(retainedNativeInputPressureHostSource(serverUrl), 'raw'),
      requestTimeoutMs:3000 };
    let effects = 0, controls = 0, binding: HostCustodyBinding | undefined;
    const owner: HostCustodyOwner = { mainEpoch:'TEST-main-input', attach(context) {
      binding = context.binding;
      return { onReadable:()=>()=>{}, handle(call) {
        if (call.operation === 'write') { effects++; return {operation:'write',state:'completed'}; }
        if (call.operation === 'observe') { controls++; return {operation:'observe',root:'running'}; }
        throw new Error('TEST unexpected native effect');
      } };
    } };
    const transport = client(profile, owner); await transport.start();
    const gate = retainedNativeInputCompletionGate(transport);
    try {
      const requested = transport.request('TEST.blocked-native', {expire,payload:'x'.repeat(1024*1024-2048)});
      await Promise.race([gate.blocked, requested.then(()=>{ throw new Error('TEST missing original write barrier'); })]);
      await Promise.race([gate.queued, requested.then(()=>{ throw new Error('TEST native call never reached Main admission'); })]);
      if (expire) expect(await requested).toMatchObject({status:expect.stringMatching(/^(unknown|refused)$/u)});
      expect(effects).toBe(0);
      expect(await transport.request('TEST.control', undefined, {control:true}))
        .toMatchObject({status:'completed',value:{operation:'observe'}});
      expect(controls).toBe(1); expect(effects).toBe(0);
      gate.release();
      if (!expire) expect(await requested).toEqual({status:'completed',value:{operation:'write',state:'completed'}});
      expect(effects).toBe(expire?0:1);
      if (!expire) {
        if (!binding) throw new Error('TEST original binding missing');
        await expect(transport.request('TEST.missing-budget', {binding}, {control:true}))
          .rejects.toMatchObject({code:'protocol-error',outcome:'unknown'});
        expect(effects, 'An incompatible private envelope cannot start another effect').toBe(1);
      }
    } finally { gate.restore(); await transport.shutdown(); }
  });

  it('keeps the original TEST physical owner across Host loss, without replaying an unacknowledged write', async () => {
    const profile = await fixture(
      `
      nativeRead: { lane: 'work', handle: async () => {
        let off = () => {};
        await new Promise(resolve => { off = server.nativeCustody.onReadable(resolve); }); off();
        return server.nativeCustody.request({operation:'read', capability:'TEST-original', stream:'stdout'});
      } },
      nativeWrite: { lane:'work', handle: bytes => server.nativeCustody.request({operation:'write', capability:'TEST-original', bytes}) },
      nativeObserve: { lane:'control', handle: () => server.nativeCustody.request({operation:'observe', capability:'TEST-original'}) },
      nativeStop: { lane:'control', handle: () => server.nativeCustody.request({operation:'stop', capability:'TEST-original', attemptRef:'TEST-stop', budgetMs:1000}) },
    `,
      'server',
      'nativeCustody: { timeoutMs: 2000 },'
    );
    const physical = spawn(
      nodeExecutable,
      [
        '-e',
        "process.stdout.write('TEST-private-stream'); process.stdin.on('data', b => process.stdout.write(b));",
      ],
      { cwd: profile.cwd, env: { ...profile.env }, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let physicallyClosed = false,
      notify: ((hint: HostCustodyHint) => void) | undefined;
    const physicalExit = new Promise<void>((resolve) =>
      physical.once('close', () => {
        physicallyClosed = true;
        resolve();
      })
    );
    const writes: string[] = [],
      releases: (() => void)[] = [];
    const commits: (() => void)[] = [];
    const committed = [0, 1].map(() => new Promise<void>((resolve) => commits.push(resolve)));
    let deferRead = false;
    let releaseRead: ((value: HostCustodyResult) => void) | undefined;
    let readStarted: (() => void) | undefined, lateReadable: (() => void) | undefined;
    let attached: { exited: boolean } | undefined, source: string | undefined;
    const ready = () => {
      if (physical.stdout.readableLength || physical.stdout.readableEnded) {
        notify?.({ capability: 'TEST-original', stream: 'stdout' });
        lateReadable?.();
      }
    };
    physical.stdout.on('readable', ready).on('end', ready);
    const owner: HostCustodyOwner = {
      mainEpoch: 'TEST-main-original',
      attach(context) {
        if (attached && !attached.exited) throw new Error('Old captured Host has not exited');
        if (source && source !== context.binding.profileDigest) throw new Error('Changed source');
        source = context.binding.profileDigest;
        const current = { exited: false };
        attached = current;
        void context.hostExited.then(() => {
          current.exited = true;
        });
        return {
          onReadable(observer) {
            notify = observer;
            ready();
            return () => {
              if (notify === observer) notify = undefined;
            };
          },
          async handle(call): Promise<HostCustodyResult> {
            if (context.signal.aborted || call.capability !== 'TEST-original')
              throw new Error('Sealed original binding');
            if (call.operation === 'read') {
              if (deferRead) {
                deferRead = false;
                expect(physical.stdout.readableLength).toBe(0);
                const pending = new Promise<HostCustodyResult>((resolve) => {
                  releaseRead = resolve;
                });
                readStarted?.();
                return pending;
              }
              const length = Math.min(physical.stdout.readableLength, 16 * 1024);
              const bytes = length ? (physical.stdout.read(length) as Buffer) : undefined;
              const emptyState = physical.stdout.readableEnded ? 'eof' : 'empty';
              return {
                operation: 'read',
                state: bytes ? 'data' : emptyState,
                bytes: bytes?.toString('base64') ?? '',
                more: physical.stdout.readableLength > 0,
              };
            }
            if (call.operation === 'write') {
              await new Promise<void>((resolve, reject) =>
                physical.stdin.write(Buffer.from(call.bytes, 'base64'), (error) =>
                  error ? reject(error) : resolve()
                )
              );
              const index = writes.push(call.bytes) - 1;
              const pending = new Promise<void>((resolve) => releases.push(resolve));
              commits[index]?.();
              await pending; // Lose only this application ACK; the original physical write already completed.
              return { operation: 'write', state: 'completed' };
            }
            if (call.operation === 'observe')
              return { operation: 'observe', root: physicallyClosed ? 'exited' : 'running' };
            if (call.operation === 'stop') {
              physical.kill();
              physical.stdout.off('readable', ready).off('end', ready).resume();
              physical.stderr.resume();
              await physicalExit;
              return { operation: 'stop', state: 'unknown' }; // A TEST leaf exit is never a fabricated Job receipt.
            }
            throw new Error('TEST owner has no other capability');
          },
        };
      },
    };
    try {
      const a = client(profile, owner);
      await a.start();
      const first = await a.request('nativeRead');
      expect(first).toMatchObject({
        status: 'completed',
        value: {
          operation: 'read',
          state: 'data',
          bytes: Buffer.from('TEST-private-stream').toString('base64'),
        },
      });
      deferRead = true;
      const oldReadStarted = new Promise<void>((resolve) => {
        readStarted = resolve;
      });
      const lateData = new Promise<void>((resolve) => {
        lateReadable = resolve;
      });
      notify?.({ capability: 'TEST-original', stream: 'stdout' });
      const oldEmptyRead = a.request('nativeRead');
      await oldReadStarted;
      physical.stdin.write('TEST-ready-during-read');
      await lateData;
      lateReadable = undefined;
      releaseRead?.({ operation: 'read', state: 'empty', bytes: '', more: false });
      expect(await oldEmptyRead).toMatchObject({ status: 'completed', value: { state: 'empty' } });
      expect(await a.request('nativeRead')).toMatchObject({
        status: 'completed',
        value: { state: 'data', bytes: Buffer.from('TEST-ready-during-read').toString('base64') },
      });
      const bytesA = Buffer.from('TEST-write-A').toString('base64');
      const lost = a.request('nativeWrite', bytesA).catch((error: unknown) => error);
      await committed[0];
      expect((await a.shutdown()).childExit).toBe('confirmed');
      expect(await lost).toMatchObject({ outcome: 'unknown' });
      expect(physicallyClosed).toBe(false);
      const b = client(profile, owner);
      await b.start();
      expect(await b.request('nativeObserve', undefined, { control: true })).toMatchObject({
        status: 'completed',
        value: { root: 'running' },
      });
      const bytesB = Buffer.from('TEST-write-B').toString('base64');
      let finishedB = false;
      const current = b.request('nativeWrite', bytesB);
      const finished = () => {
        finishedB = true;
      };
      void current.then(finished, finished);
      await committed[1];
      releases[0]?.();
      await new Promise((resolve) => setImmediate(resolve));
      expect(finishedB, 'Late Host A reply cannot settle Host B request').toBe(false);
      releases[1]?.();
      expect(await current).toMatchObject({ status: 'completed', value: { operation: 'write' } });
      expect(writes).toEqual([bytesA, bytesB]);
      expect(a.takeNotifications().notifications).toEqual([]);
      expect(b.takeNotifications().notifications).toEqual([]);
      expect(await b.request('nativeStop', undefined, { control: true })).toMatchObject({
        status: 'completed',
        value: { operation: 'stop', state: 'unknown' },
      });
      expect(physicallyClosed).toBe(true);
    } finally {
      releaseRead?.({ operation: 'read', state: 'empty', bytes: '', more: false });
      for (const release of releases) release();
      if (!physicallyClosed) physical.kill('SIGKILL');
      physical.stdout.off('readable', ready).off('end', ready).resume();
      physical.stderr.resume();
      await physicalExit;
    }
  });

  it('reserves native control under full reverse request and shared reply-byte budgets', async () => {
    const profile = await fixture(
      `
      interleave: { lane:'work', handle: async () => Promise.all([
        server.nativeCustody.request({operation:'write', capability:'TEST-first', bytes:'MQ=='}),
        server.nativeCustody.request({operation:'write', capability:'TEST-second', bytes:'Mg=='}),
        server.nativeCustody.request({operation:'observe', capability:'TEST-original'}),
        server.nativeCustody.request({operation:'end', capability:'TEST-original'}),
      ]) },
      pressure: { lane:'work', handle: async () => {
        const work = Array.from({length:24}, (_, i) => server.nativeCustody.request({operation:'read', capability:'TEST-held-' + i, stream:'stdout'}));
        const overflow = server.nativeCustody.request({operation:'read', capability:'TEST-overflow', stream:'stdout'});
        return {work: await Promise.all(work), overflow: await overflow};
      } },
      nativeStop: {lane:'control', handle: () => server.nativeCustody.request({operation:'stop', capability:'TEST-original', attemptRef:'TEST-control', budgetMs:1000})},
    `,
      'server',
      'nativeCustody:{timeoutMs:2000}, limits:{maxFrameBytes:65536,maxPriorityBytes:196608},'
    );
    const held: ((value: HostCustodyResult) => void)[] = [];
    const order: string[] = [];
    let stoppedWith = 0, workReleased = false, workAdmitted!: () => void;
    const ready = new Promise<void>(resolve => { workAdmitted = resolve; });
    const owner: HostCustodyOwner = {
      mainEpoch: 'TEST-main-pressure',
      attach: () => ({
        onReadable: () => () => undefined,
        handle(call) {
          if (call.operation === 'write') {
            order.push('write:' + Buffer.from(call.bytes, 'base64').toString());
            return { operation: 'write', state: 'completed' };
          }
          if (call.operation === 'observe') {
            order.push('observe');
            return { operation: 'observe', root: 'running' };
          }
          if (call.operation === 'end') {
            order.push('end');
            return { operation: 'end', state: 'completed' };
          }
          if (call.operation === 'read') {
            if (workReleased) return { operation: 'read', state: 'empty', bytes: '', more: false };
            return new Promise<HostCustodyResult>(resolve => {
              held.push(resolve); if (held.length === 3) workAdmitted();
            });
          }
          if (call.operation !== 'stop') throw new Error('Unexpected TEST operation');
          stoppedWith = held.length; workReleased = true;
          for (const release of held)
            release({ operation: 'read', state: 'empty', bytes: '', more: false });
          return { operation: 'stop', state: 'unknown' };
        },
      }),
    };
    const transport = client({ ...profile, requestTimeoutMs: 3000 }, owner);
    await transport.start();
    const interleaved = (await transport.request('interleave')) as { status: string }[];
    expect(order).toEqual(['write:1', 'observe', 'write:2', 'end']);
    expect(interleaved.map((reply) => reply.status)).toEqual(Array(4).fill('completed'));
    const pressure = transport.request('pressure');
    await Promise.race([ready, pressure.then(() => { throw new Error('TEST pressure finished before its original barrier'); })]);
    const stop = await transport.request('nativeStop', undefined, { control: true });
    const result = (await pressure) as { work: { status: string }[]; overflow: unknown };
    expect(stoppedWith).toBeGreaterThan(0);
    expect(
      stoppedWith,
      'Original byte reservation holds further work before native effect'
    ).toBeLessThan(24);
    expect(result.overflow).toEqual({ status: 'completed', value: { operation: 'read', state: 'empty', bytes: '', more: false } });
    expect(result.work.filter((reply) => reply.status === 'completed')).toHaveLength(24);
    expect(stop).toEqual({ status: 'completed', value: { operation: 'stop', state: 'unknown' } });
    expect(transport.takeNotifications().notifications).toEqual([]);
  });

  it('starts the actual public CLI with the selected standalone Node artifact', async () => {
    const hostEntry = await realpath(fileURLToPath(cliUrl));
    const hostEntrySha256 = createHash('sha256')
      .update(await readFile(hostEntry))
      .digest('hex');
    const transport = client({
      ...(await fixture()),
      hostEntry,
      hostEntrySha256,
      expectedBuildId: 'legacy-agent-host/0.1.0',
    });
    expect((await transport.start()).capabilities).toContain('transport.ndjson');
    await expect(transport.request('nonexistent')).rejects.toMatchObject({
      code: 'remote-rejected',
      outcome: 'rejected',
    });
    expect((await transport.shutdown()).childExit).toBe('confirmed');
  });

  it('handshakes with the packed host, serves two inputs, then confirms scoped close', async () => {
    const nativeIdentity = '01234567-89ab-4cde-8fab-0123456789ab:42:7:123456';
    const originalHash = createHash('sha256').update(nativeIdentity, 'utf8').digest('hex');
    const selected = { profileId: 'TEST-metadata-profile', configRevision: 'TEST-metadata-revision' };
    const producerUrl = new URL('./adapters/providers/createClaudeCloseDiagnostic.js', serverUrl).href;
    const profile = await fixture(`metadata: (() => {
      let observe;
      return { lane: 'work', handle: async (stage) => {
        const { createOpenCodeMetadataDiagnostic } = await import(${JSON.stringify(producerUrl)});
        observe ??= createOpenCodeMetadataDiagnostic(${JSON.stringify(selected)});
        if (stage === 'ready') observe.ready({ pid: 42, startIdentity: ${JSON.stringify(nativeIdentity)} });
        else if (stage === 'released') observe.closed(true);
        return process.pid;
      } };
    })(),`);
    const transport = client(profile);
    const log = installPersistentAppLog({ directory: join(profile.cwd, 'userData/logs'), appVersion: 'TEST' });
    let onReady: () => void = () => undefined, onReleased: () => void = () => undefined;
    const ready = new Promise<void>(resolve => { onReady = resolve; });
    const released = new Promise<void>(resolve => { onReleased = resolve; });
    const removeSink = addLogSink(entry => {
      if (entry.namespace !== 'Host:OpenCodeMetadata') return;
      const observation = entry.args[1] as { stage?: string };
      if (observation.stage === 'ready') onReady();
      if (observation.stage === 'released') onReleased();
    });
    const oldExecutable = process.env.OPENCODE_V2_EMBEDDED_BUN;
    process.env.OPENCODE_V2_EMBEDDED_BUN = '/TEST/bun';
    try {
      const handshake = await transport.start();
      expect(handshake).toMatchObject({ protocolVersion: 1, buildId: 'TEST-host-v1' });
      const [hostPid] = await Promise.all([transport.request('metadata', 'ready'), ready]);
      if (typeof hostPid !== 'number') throw new Error('TEST original Host PID missing');
      await log.flush();
      // Constructed native facts exercise observation parsing, not native process qualification.
      const host = { pid: hostPid, parentPid: 1, groupId: hostPid, birth: 'TEST-host', command: nodeExecutable };
      const metadata = { pid: 42, parentPid: hostPid, groupId: 42, birth: 'TEST-physical-birth', command: '/TEST/bun' };
      const captured = { host, children: [metadata] };
      const lineage = readDesktopMetadataLineage(profile.cwd, captured, [desktopMetadataProfileHash(selected)], [metadata]);
      expect(lineage.events[0]?.startIdentityHash).toBe(originalHash);
      expect(await readFile(log.filePath, 'utf8')).not.toContain(nativeIdentity);
      expect(JSON.parse(formatPersistentLogMessage([{ startIdentity: nativeIdentity }])).startIdentity,
        'ordinary UUID redaction remains enabled').toBe('[redacted]:42:7:123456');
      expect(await transport.request('echo', { input: 'A' })).toEqual({ input: 'A' });
      expect(await transport.request('echo', { input: 'B' })).toEqual({ input: 'B' });
      await Promise.all([transport.request('metadata', 'released'), released]);
      await log.flush();
      const original = { ...captured, metadataLineage: lineage };
      const closed = assertDesktopMetadataLineageReleased(profile.cwd, original, []);
      expect(closed.events.map(value => value.startIdentityHash)).toEqual([originalHash, originalHash]);
      const persisted = await readFile(log.filePath, 'utf8');
      const records = persisted.trim().split('\n').map(line => JSON.parse(line) as { message: string });
      const prefix = 'OpenCode metadata stage ';
      const closeRecord = records.at(-1)!;
      const closeValue = JSON.parse(closeRecord.message.slice(prefix.length)) as Record<string, unknown>;
      for (const invalid of [
        { ...closeValue, startIdentityHash: undefined, startIdentity: nativeIdentity },
        { ...closeValue, startIdentityHash: '[redacted]' },
        { ...closeValue, startIdentityHash: 'f'.repeat(64) },
        { ...closeValue, profileHash: 'f'.repeat(64) },
      ]) {
        const changed = [...records.slice(0, -1), { ...closeRecord, message: prefix + JSON.stringify(invalid) }];
        await writeFile(log.filePath, changed.map(value => JSON.stringify(value)).join('\n') + '\n');
        expect(() => assertDesktopMetadataLineageReleased(profile.cwd, original, [])).toThrow();
      }
      await writeFile(log.filePath, persisted);
      expect(await transport.shutdown()).toEqual({ childExit: 'confirmed', providerCustody: 'unresolved' });
      await expect(transport.request('echo', {})).rejects.toMatchObject({ code: 'shutting-down', outcome: 'not-dispatched' });
    } finally {
      removeSink(); log.dispose();
      if (oldExecutable === undefined) delete process.env.OPENCODE_V2_EMBEDDED_BUN;
      else process.env.OPENCODE_V2_EMBEDDED_BUN = oldExecutable;
    }
  });

  it('keeps a committed effect unknown after response loss and never replays it', async () => {
    const profile = await fixture();
    const transport = client(profile);
    await transport.start();
    await expect(transport.request('loss')).rejects.toMatchObject({ outcome: 'unknown' });
    expect(await readFile(join(profile.cwd, 'effects'), 'utf8')).toBe('effect\n');
    await expect(transport.request('loss')).rejects.toMatchObject({ outcome: 'not-dispatched' });
    expect(await readFile(join(profile.cwd, 'effects'), 'utf8')).toBe('effect\n');
  });

  it('does not turn a generic remote exception after an effect into a rejection receipt', async () => {
    const profile = await fixture();
    const transport = client(profile);
    await transport.start();
    const error = await transport.request('failure').catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'remote-error', outcome: 'unknown' });
    expect(String(error)).not.toContain('private payload');
    expect(await readFile(join(profile.cwd, 'effects'), 'utf8')).toBe('effect\n');
  });

  it.each([
    ['malformed', `process.stdout.write('{not-json}\\n');`],
    ['oversized', `process.stdout.write('x'.repeat(1024 * 1024 + 1));`],
    ['invalid UTF8', `process.stdout.write(Buffer.from([0xff, 10]));`],
  ])('rejects %s frames before treating them as successful responses', async (_label, action) => {
    const profile = await fixture(
      `bad: { lane: 'work', handle: () => { ${action} return 'ignored'; } },`
    );
    const transport = client(profile);
    await transport.start();
    await expect(transport.request('bad')).rejects.toMatchObject({
      code: 'protocol-error',
      outcome: 'unknown',
    });
    expect((await transport.shutdown()).childExit).toBe('confirmed');
  });

  it('reserves request capacity for control while work requests wait', async () => {
    const transport = client({ ...(await fixture()), requestTimeoutMs: 2000 });
    const { limits } = await transport.start();
    const work = Array.from(
      { length: limits.maxPendingRequests - limits.reservedControlRequests },
      () => transport.request('hold').catch((error: unknown) => error)
    );
    await expect(transport.request('echo', 'overflow')).rejects.toMatchObject({
      code: 'capacity-exceeded',
      outcome: 'not-dispatched',
    });
    expect(await transport.request('control', undefined, { control: true })).toBe(
      'control-progress'
    );
    await transport.shutdown();
    await Promise.all(work);
  });

  it('request timeout retains unknown outcome while independent control remains available', async () => {
    const transport = client({ ...(await fixture()), requestTimeoutMs: 80 });
    await transport.start();
    await expect(transport.request('hold')).rejects.toMatchObject({
      code: 'request-timeout',
      outcome: 'unknown',
    });
    expect(await transport.request('control', undefined, { control: true })).toBe(
      'control-progress'
    );
    expect((await transport.shutdown()).childExit).toBe('confirmed');
  });

  it('bounds notifications and exposes a gap without blocking responses', async () => {
    const transport = client(await fixture());
    const { limits } = await transport.start();
    expect(await transport.request('notify')).toBe('done');
    const notifications = transport.takeNotifications();
    expect(notifications.gap).toBe(true);
    expect(notifications.notifications.length).toBeLessThanOrEqual(limits.maxDataNotifications);
    expect(await transport.request('control', undefined, { control: true })).toBe(
      'control-progress'
    );
  });

  it('rejects changed selected bytes before host allocation', async () => {
    const profile = await fixture();
    await writeFile(profile.hostEntry, 'throw new Error("must never allocate");');
    const transport = client(profile);
    await expect(transport.start()).rejects.toMatchObject({
      code: 'profile-mismatch',
      outcome: 'not-dispatched',
    });
    expect((await transport.shutdown()).childExit).toBe('confirmed');
  });

  it('rejects mismatched host build identity', async () => {
    const transport = client({ ...(await fixture()), expectedBuildId: 'another-build' });
    await expect(transport.start()).rejects.toMatchObject({ code: 'profile-mismatch' });
    expect((await transport.shutdown()).childExit).toBe('confirmed');
  });

  it('seals pending startup before validation can spawn the host', async () => {
    const profile = await fixture();
    const transport = client(profile);
    const opening = transport.start();
    await transport.shutdown();
    await expect(opening).rejects.toMatchObject({
      code: 'shutting-down',
      outcome: 'not-dispatched',
    });
  });

  it('shutdown does not kill an unrelated captured test child', async () => {
    const profile = await fixture();
    const unrelated = spawn(nodeExecutable, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: profile.cwd,
      env: { ...profile.env },
      stdio: 'ignore',
    });
    unrelatedChildren.push(unrelated);
    const transport = client(profile);
    await transport.start();
    await transport.shutdown();
    expect(unrelated.exitCode).toBeNull();
    expect(unrelated.signalCode).toBeNull();
  });
  it.each([200, 6000])(
    'waits for advertised cleanup budget %d before signaling the original Host',
    async (disposeTimeoutMs) => {
      const profile = await fixture(
        `
      import { createHostServer } from ${JSON.stringify(serverUrl)};
      import { appendFileSync } from 'node:fs';
      const server = createHostServer({
        input: process.stdin, output: process.stdout, buildId: 'TEST-host-v1',
        limits: { disposeTimeoutMs: ${disposeTimeoutMs} },
        async onDispose() {
          await new Promise(resolve => setTimeout(resolve, 80));
          appendFileSync(process.env.HOME + '/cleanup', 'completed');
        },
      });
      process.on('SIGTERM', () => appendFileSync(process.env.HOME + '/signals', 'SIGTERM'));
      void server.closed.then(result => process.exit(result.cleanup === 'completed' ? 0 : 1));
    `,
        'raw'
      );
      const transport = client({ ...profile, shutdownTimeoutMs: 20 });
      await transport.start();
      expect((await transport.shutdown()).childExit).toBe('confirmed');
      expect(await readFile(join(profile.env.HOME, 'cleanup'), 'utf8')).toBe('completed');
      await expect(readFile(join(profile.env.HOME, 'signals'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  );

  it('keeps finite Host cleanup timeout distinct from confirmed child exit and provider release', async () => {
    const profile = await fixture(
      `
      import { createHostServer } from ${JSON.stringify(serverUrl)};
      import { writeFileSync } from 'node:fs';
      const server = createHostServer({
        input: process.stdin, output: process.stdout, buildId: 'TEST-host-v1',
        limits: { disposeTimeoutMs: 40 },
        onDispose: () => new Promise(() => {}),
      });
      void server.closed.then(result => {
        writeFileSync(process.env.HOME + '/close-result', JSON.stringify(result));
        process.exit(result.cleanup === 'completed' ? 0 : 1);
      });
    `,
      'raw'
    );
    const transport = client({ ...profile, shutdownTimeoutMs: 20 });
    await transport.start();
    expect(await transport.shutdown()).toEqual({
      childExit: 'confirmed',
      providerCustody: 'unresolved',
    });
    expect(JSON.parse(await readFile(join(profile.env.HOME, 'close-result'), 'utf8'))).toEqual({
      reason: 'input_eof',
      cleanup: 'timeout',
    });
  });
});
