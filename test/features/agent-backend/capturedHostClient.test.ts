// @vitest-environment node
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RetainedWindowsCustody } from '@agent-teams/legacy-agent-host/owned-process';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { assertDesktopMetadataLineageReleased, desktopMetadataProfileHash,
  readDesktopMetadataLineage } from '../../../scripts/legacy-agent-host/desktop-opencode-metadata-lineage';
import {
  CapturedHostClient,
  createCapturedHostClient,
  type SelectedHostProfile,
} from '../../../src/features/agent-backend/main';
import { capturedHostProfileDigest } from '../../../src/features/agent-backend/main/infrastructure/selectedHostProfile';
import * as linuxLaunch from '../../../src/main/utils/linuxChildLaunch';
import { linuxChildLaunchFailure } from '../../../src/main/utils/linuxChildLaunchSelection';
import { formatPersistentLogMessage, installPersistentAppLog } from '../../../src/main/utils/persistentAppLog';
import { addLogSink } from '../../../src/shared/utils/logger';

import {
  assertRetainedServiceCapacity,
  retainedNativeHostSource,
  retainedNativeInputCompletionGate,
  retainedNativeInputPressureHostSource,
  retainedNativePayloadDigest,
  retainedNativePressureHostSource,
  retainedNativePressurePrimitive,
  retainedNativePrimitive,
  retainedServiceHostSource,
  retainedServicePrimitive,
} from './fixtures/retainedNativeCustody';

import type { JsonValue } from '@agent-teams/legacy-agent-host';
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

function client(profile: SelectedHostProfile, owner?: HostCustodyOwner, remaining?: () => number): CapturedHostClient {
  const instance = remaining
    ? new CapturedHostClient(profile, owner, remaining) : createCapturedHostClient(profile, owner);
  clients.push(instance);
  return instance;
}

describe('captured legacy host client over real subprocess stdio', () => {

  it('retains unresolved service admission beyond the released cache and refuses before capacity effect',
    assertRetainedServiceCapacity);

  it('keeps the original service intent and scope through late ACK and a successor Host', async () => {
    const profile = { ...await fixture(retainedServiceHostSource(serverUrl), 'raw'), requestTimeoutMs: 3000 };
    const service = retainedServicePrimitive();
    const primitive = retainedNativePrimitive({ services: service.port });
    let current = true;
    const owner = new RetainedWindowsCustody({
      profileId: profile.profileId, profileDigest: capturedHostProfileDigest(profile),
      selectBroker: () => ({ path: 'C:\\TEST\\owned-process-broker.exe', sha256: '2'.repeat(64),
        arch: 'x64', protocol: 1, capability: 'service-scopes-v1' }),
      async verifyLaunch() { expect(current).toBe(true); },
      createPort: () => primitive.port,
    });
    const original = client(profile, owner);
    const foreignOwner = new RetainedWindowsCustody({
      profileId: profile.profileId, profileDigest: capturedHostProfileDigest(profile),
      selectBroker() { throw new Error('TEST foreign owner must not allocate'); },
      async verifyLaunch() { throw new Error('TEST foreign owner must not launch'); },
    });
    const neverStarted = client(profile, owner);
    let successor: CapturedHostClient | undefined;
    try {
      expect(original.recoveryState(owner)).toBe('held');
      expect((await neverStarted.shutdown()).childExit).toBe('confirmed');
      expect(neverStarted.recoveryState(owner)).toBe('held');
      await original.start();
      expect(original.recoveryState(owner)).toBe('ready');
      expect(original.recoveryState(foreignOwner)).toBe('held');
      expect(await original.request('launch')).toBe(true);
      const first = await original.request('capture') as { intent: JsonValue; initial: JsonValue };
      expect(first.initial).toEqual({ state: 'unknown' });
      expect(service.calls.capture).toBe(1);
      service.replyCapture();
      expect(await original.request('repeat')).toEqual({ state: 'unknown' });
      const captured = await original.request('lookup', first.intent) as { state: string; capture: JsonValue };
      expect(captured.state).toBe('captured');
      expect(await original.request('query', captured.capture))
        .toMatchObject({ state: 'observed', observation: 'same-live' });
      await expect(original.request('crash')).rejects.toMatchObject({ outcome: 'unknown' });
      expect((await original.shutdown()).childExit).toBe('confirmed');
      expect(original.recoveryState(owner)).toBe('closed');
      expect(original.recoveryState(foreignOwner)).toBe('held');
      expect(primitive.calls.stopped).toBe(0);
      current = false; // Changed source cannot discard original capture/control authority.
      successor = client(profile, owner);
      expect(successor.recoveryState(owner)).toBe('held');
      await successor.start();
      expect(successor.recoveryState(owner)).toBe('ready');
      expect(original.recoveryState(owner)).toBe('closed');
      expect(await successor.request('serializedRun', first.intent)).toEqual({ state: 'unknown' });
      expect(await successor.request('lookup', first.intent)).toEqual(captured);
      const stopped = await successor.request('stop', captured.capture) as { intent: JsonValue; initial: JsonValue };
      expect(stopped.initial).toMatchObject({ state: 'stopped', observation: 'absent', evidence: 'native-scope' });
      expect(await successor.request('lookup', stopped.intent)).toEqual(stopped.initial);
      expect(await successor.request('query', captured.capture))
        .toMatchObject({ state: 'observed', observation: 'absent', evidence: 'retained-terminal' });
      expect(await successor.request('settle', captured.capture)).toMatchObject({ state: 'settled' });
      expect(await successor.request('query', captured.capture))
        .toMatchObject({ state: 'observed', observation: 'absent', evidence: 'retained-terminal' });
      expect(service.calls).toEqual({ capture: 1, query: 1, stop: 1, settle: 1 });
      expect(primitive.calls).toMatchObject({ stopped: 0, released: 0 });
      expect(await owner.close()).toBe(true);
      expect(primitive.calls).toMatchObject({ stopped: 1, released: 1 });
    } finally {
      await original.shutdown(); await successor?.shutdown(); await owner.close();
      expect(await foreignOwner.close()).toBe(true);
    }
  });

  it.each(['job-membership', 'no-local-dispatch'] as const)(
    'derives retained service absence only from the original whole-Job proof: %s',
    async coverage => {
      const profile = { ...await fixture(retainedServiceHostSource(serverUrl), 'raw'), requestTimeoutMs: 3000 };
      const service = retainedServicePrimitive();
      const primitive = retainedNativePrimitive({ services: service.port, coverage,
        onRelease: () => service.closeTransport() });
      const owner = new RetainedWindowsCustody({
        profileId: profile.profileId, profileDigest: capturedHostProfileDigest(profile),
        selectBroker: () => ({ path: 'C:\\TEST\\owned-process-broker.exe', sha256: '2'.repeat(64),
          arch: 'x64', protocol: 1, capability: 'service-scopes-v1' }),
        async verifyLaunch() {}, createPort: () => primitive.port,
      });
      const original = client(profile, owner);
      try {
        await original.start(); expect(await original.request('launch')).toBe(true);
        const first = await original.request('capture') as { intent: JsonValue };
        service.replyCapture();
        const captured = await original.request('lookup', first.intent) as { capture: Record<string, JsonValue> };
        expect(await original.request('providerStop')).toBe('confirmed');
        const wrong = { ...captured.capture, root: { pid: 4141, birth: 'f'.repeat(16) } };
        expect(await original.request('query', wrong)).toEqual({ state: 'unknown' });
        const observed = await original.request('query', captured.capture);
        if (coverage === 'job-membership') {
          expect(observed).toMatchObject({ state: 'observed', observation: 'absent', evidence: 'original-whole-job' });
          expect(await original.request('settle', captured.capture)).toMatchObject({ state: 'settled' });
          expect(service.calls.query).toBe(0);
          expect(service.calls.settle).toBe(0);
        } else {
          expect(observed).toEqual({ state: 'unknown' });
          expect(service.calls.query).toBe(1);
        }
        expect(primitive.calls).toMatchObject({ stopped: 1, released: 1 });
      } finally { await original.shutdown(); await owner.close(); }
    }
  );

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
    const profile = await fixture(`
      'team.roster.replace': { lane: 'work',
        handle: () => ({ ok: false, code: 'invalid', outcome: 'rejected' }) },
    `);
    const transport = client(profile);
    const priorGate = process.env.LEGACY_DESKTOP_BACKEND_GO;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('TEST diagnostic sink failed');
    });
    try {
      delete process.env.LEGACY_DESKTOP_BACKEND_GO;
      await transport.start();
      const rejected = { ok: false, code: 'invalid', outcome: 'rejected' };
      expect(await transport.request('team.roster.replace', {})).toEqual(rejected);
      expect(logged).not.toHaveBeenCalled();

      process.env.LEGACY_DESKTOP_BACKEND_GO = '1';
      const error = await transport.request('failure').catch((value: unknown) => value);
      expect(error).toMatchObject({ code: 'remote-error', outcome: 'unknown' });
      expect(String(error)).not.toContain('private payload');
      expect(await readFile(join(profile.cwd, 'effects'), 'utf8')).toBe('effect\n');
      expect(logged).not.toHaveBeenCalled();

      const params = {
        commandId: 'TEST-private-roster-command',
        binding: {
          schemaVersion: 1,
          handleId: 'TEST-private-handle',
          owner: {
            ownerId: 'TEST-private-owner',
            revision: 'TEST-private-revision',
            storageRoot: profile.cwd,
            profileId: 'TEST-private-profile',
            protocolVersion: 1,
            buildId: 'TEST-private-build',
            nodeSha256: 'b'.repeat(64),
            hostEntrySha256: 'c'.repeat(64),
          },
          scope: {
            projectId: 'TEST-private-project',
            workspaceId: 'TEST-private-workspace',
            teamId: 'TEST-private-team',
            runId: 'TEST-private-run',
            memberId: null,
            generation: null,
          },
        },
        payload: {
          expectedRevision: 'a'.repeat(64),
          members: [],
          savedSettings: { cwd: profile.cwd, prompt: 'TEST-private-original-prompt' },
        },
        liveRoster: { phase: 'capture', remainingMs: 1000.5 },
        'TEST-private-unknown-key': 'TEST-private-unknown-value',
      };
      const committedParams = createHash('sha256').update(JSON.stringify(params)).digest('hex');
      const committedPayload = createHash('sha256')
        .update(JSON.stringify(params.payload))
        .digest('hex');
      const pending = transport.request('team.roster.replace', params);
      params.payload.savedSettings.prompt = 'TEST-private-later-prompt';
      expect(await pending).toEqual(rejected);
      expect(logged).toHaveBeenCalledTimes(1);
      const [namespace, output] = logged.mock.calls[0] ?? [];
      expect(namespace).toBe('[TEST:HostRosterWire]');
      expect(typeof output).toBe('string');
      const serialized = String(output);
      expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(4096);
      expect(serialized).not.toContain('TEST-private');
      expect(serialized).not.toContain(profile.cwd);
      expect(serialized).not.toContain('a'.repeat(64));
      const observation: unknown = JSON.parse(serialized);
      expect(observation).toMatchObject({
        tag: 'HOST_ROSTER_REJECTED_WIRE',
        hashes: {
          frame: expect.stringMatching(/^[a-f0-9]{64}$/),
          params: committedParams,
          payload: committedPayload,
        },
        fields: {
          params: { type: 'object', unknownKeys: 1 },
          payload: { known: { members: 'array', savedSettings: 'object' }, unknownKeys: 0 },
          savedSettings: { known: { cwd: 'string', prompt: 'string', model: 'absent' } },
          scope: { known: { memberId: 'null', generation: 'null' } },
        },
        members: 0,
        liveRoster: {
          phase: 'capture',
          remainingMs: { present: true, type: 'number', integer: false, inRange: true },
        },
      });
      expect(await transport.request('team.roster.replace', params)).toEqual(rejected);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
      if (priorGate === undefined) delete process.env.LEGACY_DESKTOP_BACKEND_GO;
      else process.env.LEGACY_DESKTOP_BACKEND_GO = priorGate;
    }
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
    const selected = { ...(await fixture()), requestTimeoutMs: 80 };
    const transport = client(selected);
    await transport.start();
    for (const remaining of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(transport.request('failure', undefined, { remainingMs: () => remaining }))
        .rejects.toMatchObject({ code: 'request-timeout', outcome: 'not-dispatched' });
    }
    await expect(readFile(join(selected.cwd, 'effects'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(transport.request('hold')).rejects.toMatchObject({
      code: 'request-timeout',
      outcome: 'unknown',
    });
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      await expect(transport.request('hold', undefined, { remainingMs: () => 20 }))
        .rejects.toMatchObject({ code: 'request-timeout', outcome: 'unknown' });
      expect(timers.mock.calls.some(([, delay]) => delay === 20)).toBe(true);
    } finally { timers.mockRestore(); }
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

    // A synthetic private helper failure still owns the actual Node child.
    // No helper allocation/empty EOF is promoted to a Host handshake.
    let allocated: ChildProcess | undefined;
    const observe = vi.spyOn(linuxLaunch, 'observeLinuxChildLaunchFailure').mockImplementation((child, listener) => {
      allocated = child;
      queueMicrotask(() => listener(linuxChildLaunchFailure('status', true)));
      return () => {};
    });
    try {
      const stalled = client(await fixture('process.stdin.resume(); setInterval(() => {}, 1000);', 'raw'));
      await expect(stalled.start()).rejects.toMatchObject({ code: 'transport-closed', outcome: 'unknown' });
      expect(allocated?.pid).toBeGreaterThan(0);
      expect(allocated?.exitCode).toBeNull(); expect(allocated?.signalCode).toBeNull();
      await expect(stalled.request('echo')).rejects.toMatchObject({ outcome: 'not-dispatched' });
      expect((await stalled.shutdown()).childExit).toBe('confirmed');
      expect(allocated?.exitCode !== null || allocated?.signalCode !== null).toBe(true);
    } finally { observe.mockRestore(); }
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

    // The same trusted budget reaches the actual Node version subprocess.
    const validationProfile = await fixture();
    const originalLimit = validationProfile.startupTimeoutMs - 1;
    let remaining = originalLimit, observedVersion = '';
    let observedTimeout: number | undefined;
    const execute = linuxLaunch.execFileWithLinuxChildLaunch;
    const version = vi.spyOn(linuxLaunch, 'execFileWithLinuxChildLaunch')
      .mockImplementation((command, args, options, callback, deadline, onFailure) => {
        observedTimeout = options.timeout;
        return execute(command, args, options, (error, stdout, stderr) => {
          observedVersion = String(stdout).trim();
          remaining = 0;
          callback(error, stdout, stderr);
        }, deadline, onFailure);
      });
    const validation = client(validationProfile, undefined, () => remaining);
    try {
      await expect(validation.start()).rejects.toMatchObject({
        code: 'request-timeout', outcome: 'not-dispatched',
      });
      expect(observedVersion).toBe(nodeVersion);
      expect(observedTimeout).toBe(originalLimit);
      expect(Object.getOwnPropertyDescriptor(validation, 'child')?.value).toBeUndefined();
      expect((await validation.shutdown()).childExit).toBe('confirmed');
    } finally { version.mockRestore(); }

    // Expiration after a genuine Host spawn keeps cleanup on that actual child.
    const spawnProfile = await fixture();
    let spawnRemaining = spawnProfile.startupTimeoutMs, observedClose = false;
    let allocated: ChildProcess | undefined;
    const observeFailure = linuxLaunch.observeLinuxChildLaunchFailure;
    const observe = vi.spyOn(linuxLaunch, 'observeLinuxChildLaunchFailure')
      .mockImplementation((child, listener) => {
        allocated = child;
        child.once('close', () => { observedClose = true; });
        spawnRemaining = 0;
        return observeFailure(child, listener);
      });
    const spawned = client(spawnProfile, undefined, () => spawnRemaining);
    try {
      await expect(spawned.start()).rejects.toMatchObject({
        code: 'request-timeout', outcome: 'not-dispatched',
      });
      expect(allocated?.pid).toBeGreaterThan(0);
      expect((await spawned.shutdown()).childExit).toBe('confirmed');
      expect(observedClose).toBe(true);
      expect(allocated?.exitCode !== null || allocated?.signalCode !== null).toBe(true);
    } finally { observe.mockRestore(); }
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
