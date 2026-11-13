import { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';

import { expect } from 'vitest';

import type {
  OwnedLaunchPort,
  PendingOwnedProcess,
  PreparedOwnedProcess,
  RootExit,
  TreeReceipt,
} from '@agent-teams/legacy-agent-host/owned-process';

/** A synthetic primitive for transport/lifetime assertions only. No OS/Job proof is claimed. */
export function retainedNativePrimitive() {
  const calls = { allocated: 0, prepared: 0, resumed: 0, stopped: 0, released: 0 };
  const writes: Buffer[] = [];
  const stdout = new PassThrough({ highWaterMark: 64 * 1024 });
  const stderr = new PassThrough({ highWaterMark: 64 * 1024 });
  const exitObservers = new Set<(exit: RootExit) => void>();
  const receipts = new Set<TreeReceipt>();
  let original: PreparedOwnedProcess;
  const port: OwnedLaunchPort = {
    allocate(owner) {
      expect(calls.allocated++).toBe(0);
      original = {
        owner,
        root: { pid: 4141, birth: 'a'.repeat(16) },
        stdout,
        stderr,
        stdin: new Writable({
          write(bytes: Buffer, _encoding, done) {
            expect(calls.resumed).toBe(1);
            expect(calls.stopped).toBe(0);
            writes.push(Buffer.from(bytes));
            stdout.write(bytes);
            done();
          },
        }),
        diagnostics: () => ({ writeCompleted: false }),
        async resume(expected, install) {
          expect(expected).toBe(owner);
          await install();
          calls.resumed++;
        },
        observeRootExit(callback) {
          exitObservers.add(callback);
          return () => {
            exitObservers.delete(callback);
          };
        },
        observeTransportFailure: () => () => {},
        abandonControl() {
          throw new Error('TEST cannot abandon the original owner');
        },
        async stop(request) {
          expect(request.expectedOwner).toBe(owner);
          calls.stopped++;
          stdout.end();
          stderr.end();
          const receipt: TreeReceipt = Object.freeze({
            owner,
            attemptId: request.attemptId,
            coverage: 'no-local-dispatch',
            rootExited: false,
            proofDigest: 'd'.repeat(64),
          });
          receipts.add(receipt);
          return { kind: 'confirmed', receipt };
        },
        async drain() {
          return { kind: stdout.readableEnded && stderr.readableEnded ? 'complete' : 'incomplete' };
        },
        async release(receipt, coverage) {
          expect(receipts.has(receipt)).toBe(true);
          expect(coverage).toBe('job-membership');
          calls.released++;
        },
      };
      return original;
    },
    async prepare(pending, spec) {
      expect(pending).toBe(original);
      expect(calls.allocated).toBe(1);
      calls.prepared++;
      expect(spec.executable).toBe('C:\\TEST\\claude.exe');
      expect(spec.environment).toHaveLength(16);
      expect(spec.environment.every((value) => value.length > 8192)).toBe(true);
      return { kind: 'prepared', process: original };
    },
  };
  return {
    calls,
    port,
    writes,
    rootExit() {
      for (const observer of exitObservers) observer({ code: 0, birth: 'a'.repeat(16) });
    },
  };
}

/** Actual Host subprocess and SDK facade, backed by the explicit synthetic primitive above. */
export function retainedNativeHostSource(serverUrl: string): string {
  const owned = new URL('owned-process/index.js', serverUrl).href;
  const launch = new URL('owned-process/HostWindowsLaunch.js', serverUrl).href;
  return `
    import assert from 'node:assert/strict';
    import { createHash, randomUUID } from 'node:crypto';
    import { createHostServer } from ${JSON.stringify(serverUrl)};
    import { OwnedProcessFacade } from ${JSON.stringify(owned)};
    import { HostWindowsLaunch } from ${JSON.stringify(launch)};
    let sealed = false, pending, facade, off, seals = 0, disposals = 0;
    const bridge = new HostWindowsLaunch(() => server.nativeCustody);
    const profile = { cwd:'C:\\\\TEST', executable:{path:'C:\\\\TEST\\\\claude.exe',sha256:'1'.repeat(64)},
      environment:{}, windowsBroker:{path:'C:\\\\TEST\\\\owned-process-broker.exe',sha256:'2'.repeat(64),arch:'x64',protocol:1} };
    const port = bridge.port(profile, () => !sealed);
    const server = createHostServer({input:process.stdin,output:process.stdout,buildId:'TEST-host-v1',
      nativeCustody:{timeoutMs:2000},limits:{disposeTimeoutMs:2000},
      onSeal(){ assert.equal(++seals,1); sealed = true; },
      async onDispose(){
        assert.equal(++disposals,1);
        if(!pending) return;
        const stopped = await pending.stop({expectedOwner:pending.owner,attemptId:'TEST-original-shutdown',
          mode:'force',deadlineMs:performance.now()+1500});
        assert.equal(stopped.kind,'confirmed');
        await pending.drain(performance.now()+500);
        await pending.release(stopped.receipt,'job-membership');
      },
      methods:{
        launch:{lane:'work',async handle(){
          assert.equal(pending,undefined);
          const owner={teamIncarnation:'TEST-team',runId:'TEST-run',laneId:'TEST-lane',processGeneration:randomUUID()};
          pending=port.allocate(owner);
          facade=new OwnedProcessFacade({owner,current:()=>!sealed,
            prepare:()=>port.prepare(pending,{executable:profile.executable.path,cwd:profile.cwd,
              commandLine:'TEST-bounded-argv',environment:Array.from({length:16},(_,i)=>'TEST_ENV_'+i+'='+'x'.repeat(8192))}),
            installOwner:async()=>{},requestStop:()=>false});
          facade.stderr.resume();
          const chunks=[]; let bytes=0;
          const echoed=new Promise(resolve=>facade.stdout.on('data',chunk=>{
            bytes+=chunk.length; assert.ok(bytes<=131072); chunks.push(chunk);
            if(bytes===131072) resolve();
          }));
          const written=new Promise((resolve,reject)=>{
            assert.equal(facade.stdin.write(Buffer.alloc(131072,0x63),error=>error?reject(error):resolve()),false);
          });
          await Promise.all([written,echoed]);
          return {bytes,sha256:createHash('sha256').update(Buffer.concat(chunks)).digest('hex')};
        }},
        state:{lane:'control',handle:()=>({exitCode:facade.exitCode,stdoutEnded:facade.stdout.readableEnded})},
        crash:{lane:'control',handle:()=>process.exit(91)}
      }});
    void server.closed.then(()=>process.exit(0));
  `;
}

export const retainedNativePayloadDigest = createHash('sha256')
  .update(Buffer.alloc(131072, 0x63))
  .digest('hex');

/** Same explicit synthetic owner, with barriers exposing the existing 24/32 transport limits. */
export function retainedNativePressurePrimitive() {
  const calls = { allocated: 0, prepared: 0, resumed: 0, written: 0, stopped: 0, released: 0 };
  const originals = new Map<PendingOwnedProcess, PreparedOwnedProcess>();
  let markWork!: () => void, markControl!: () => void;
  let releaseWork!: () => void, releaseControl!: () => void;
  const workFull = new Promise<void>(resolve => { markWork = resolve; });
  const controlFull = new Promise<void>(resolve => { markControl = resolve; });
  const workGate = new Promise<void>(resolve => { releaseWork = resolve; });
  const controlGate = new Promise<void>(resolve => { releaseControl = resolve; });
  const port: OwnedLaunchPort = {
    allocate(owner) {
      const index = ++calls.allocated, receipts = new Set<TreeReceipt>();
      const stdout = new PassThrough(), stderr = new PassThrough();
      let resumed = false, released = false;
      const original: PreparedOwnedProcess = {
        owner, root: { pid: 4100 + index, birth: index.toString(16).padStart(16, '0') },
        stdout, stderr,
        stdin: new Writable({ write(bytes: Buffer, _encoding, done) {
          expect(resumed).toBe(true);
          expect(bytes.equals(Buffer.from(owner.laneId))).toBe(true);
          calls.written++; done();
        } }),
        diagnostics: () => ({ writeCompleted: false }),
        async resume(expected, install) {
          expect(expected).toBe(owner); await install(); resumed = true; calls.resumed++;
        },
        observeRootExit: () => () => {},
        observeTransportFailure: () => () => {},
        abandonControl() { throw new Error('TEST original owner retained'); },
        async stop(request) {
          expect(request.expectedOwner).toBe(owner);
          if (++calls.stopped === 32) markControl();
          await controlGate;
          stdout.end(); stderr.end();
          const receipt: TreeReceipt = Object.freeze({ owner, attemptId: request.attemptId,
            coverage: 'no-local-dispatch', rootExited: false, proofDigest: index.toString(16).padStart(64, '0') });
          receipts.add(receipt);
          return { kind: 'confirmed', receipt };
        },
        async drain() { return { kind: 'complete' }; },
        async release(receipt, coverage) {
          expect(receipts.has(receipt)).toBe(true); expect(coverage).toBe('job-membership');
          expect(released).toBe(false); released = true; calls.released++;
        },
      };
      originals.set(original, original);
      return original;
    },
    async prepare(pending, spec) {
      const original = originals.get(pending);
      if (!original) throw new Error('TEST original pending mismatch');
      expect(spec.executable).toBe('C:\\TEST\\claude.exe');
      if (++calls.prepared === 24) markWork();
      await workGate;
      return { kind: 'prepared', process: original };
    },
  };
  return { calls, port, workFull, controlFull, releaseWork, releaseControl };
}

export function retainedNativePressureHostSource(serverUrl: string): string {
  const launch = new URL('owned-process/HostWindowsLaunch.js', serverUrl).href;
  return `
    import assert from 'node:assert/strict';
    import { randomUUID } from 'node:crypto';
    import { createHostServer } from ${JSON.stringify(serverUrl)};
    import { HostWindowsLaunch } from ${JSON.stringify(launch)};
    let sealed = false, close, members = [], expiredRequest;
    const closingMembers = new Map();
    const bridge = new HostWindowsLaunch(() => server.nativeCustody);
    const profile = { cwd:'C:\\\\TEST', executable:{path:'C:\\\\TEST\\\\claude.exe',sha256:'1'.repeat(64)},
      environment:{}, windowsBroker:{path:'C:\\\\TEST\\\\owned-process-broker.exe',sha256:'2'.repeat(64),arch:'x64',protocol:1} };
    const port = bridge.port(profile, () => !sealed);
    const stopOne = pending => {
      if (closingMembers.has(pending)) return closingMembers.get(pending);
      const closing = (async () => {
      const outcome = await pending.stop({expectedOwner:pending.owner,attemptId:'TEST-pressure-close',
        mode:'force',deadlineMs:performance.now()+1500});
      assert.equal(outcome.kind,'confirmed');
      await pending.drain(performance.now()+500);
      await pending.release(outcome.receipt,'job-membership');
      })(); closingMembers.set(pending,closing); return closing;
    };
    const stop = () => close ??= Promise.all(members.map(stopOne)).then(() => members.length);
    const server = createHostServer({input:process.stdin,output:process.stdout,buildId:'TEST-host-v1',
      nativeCustody:{timeoutMs:2000},limits:{disposeTimeoutMs:2000},
      onSeal(){ sealed = true; }, onDispose:stop,
      methods:{
        launch:{lane:'work',async handle(){
          assert.equal(members.length,0);
          members=Array.from({length:48},(_,i)=>port.allocate({teamIncarnation:'TEST-team',
            runId:'TEST-run',laneId:'TEST-lane-'+i,processGeneration:randomUUID()}));
          await Promise.all(members.map(async pending => {
            const prepared=await port.prepare(pending,{executable:profile.executable.path,cwd:profile.cwd,
              commandLine:'TEST-bounded-argv',environment:[]});
            assert.equal(prepared.kind,'prepared');
            prepared.process.stdout.resume(); prepared.process.stderr.resume();
            await prepared.process.resume(pending.owner,async()=>{});
            await new Promise((resolve,reject)=>prepared.process.stdin.write(Buffer.from(pending.owner.laneId),
              error=>error?reject(error):resolve()));
          }));
          return members.length;
        }},
        holdCloses:{lane:'control',handle:()=>Promise.all(members.slice(0,32).map(stopOne)).then(()=>32)},
        expireOne:{lane:'control',async handle(){
          const original=members[32];
          expiredRequest={expectedOwner:original.owner,attemptId:'TEST-expired-before-wire',
            mode:'force',deadlineMs:performance.now()+20};
          return (await original.stop(expiredRequest)).kind;
        }},
        finishExplicit:{lane:'control',async handle(){
          const count=await stop();
          return {count,originalExpired:(await members[32].stop(expiredRequest)).kind};
        }}
      }});
    void server.closed.then(()=>process.exit(0));
  `;
}

/** Hold only the original Main callback, after its real child stdin write completes. */
export function retainedNativeInputCompletionGate(client: object) {
  const captured: unknown = Object.getOwnPropertyDescriptor(client, 'child')?.value;
  if (!(captured instanceof ChildProcess) || !captured.stdin) throw new Error('TEST original Host missing');
  const pending: unknown = Object.getOwnPropertyDescriptor(client, 'nativePending')?.value;
  if (!(pending instanceof Map)) throw new Error('TEST original reverse request map missing');
  const entries: Map<unknown, unknown> = pending, originalSet = entries.set;
  let admitted!: () => void;
  const queued = new Promise<void>(resolve => { admitted = resolve; });
  const trackedSet: typeof entries.set = (key, value) => {
    const result = originalSet.call(entries, key, value); admitted(); return result;
  };
  entries.set = trackedSet;
  const stream = captured.stdin, original = stream.write, write = original.bind(stream);
  let releaseCallback: (() => void) | undefined, released = false, intercepted = false;
  let complete!: () => void, fail!: (error: Error) => void;
  const blocked = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
  const gate = (chunk: unknown, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void): boolean => {
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    let target = false;
    if (Buffer.isBuffer(chunk) && !intercepted) {
      const value: unknown = JSON.parse(chunk.toString('utf8'));
      target = typeof value === 'object' && value !== null && 'method' in value &&
        value.method === 'TEST.blocked-native';
    }
    if (!target) return encoding ? write(chunk, encoding, done) : write(chunk, done);
    if (!done) throw new Error('TEST original Main write callback missing');
    intercepted = true;
    const observed = (error?: Error | null) => {
      if (error) { done(error); fail(error); return; }
      releaseCallback = () => done();
      complete();
      if (released) { const release = releaseCallback; releaseCallback = undefined; release(); }
    };
    return encoding ? write(chunk, encoding, observed) : write(chunk, observed);
  };
  stream.write = gate;
  const release = () => {
    released = true;
    const callback = releaseCallback; releaseCallback = undefined; callback?.();
  };
  return {
    blocked, queued, release,
    restore() {
      release();
      if (stream.write === gate) stream.write = original;
      if (entries.set === trackedSet) entries.set = originalSet;
    },
  };
}

export function retainedNativeInputPressureHostSource(serverUrl: string): string {
  return `
    import { createHostServer } from ${JSON.stringify(serverUrl)};
    const server=createHostServer({input:process.stdin,output:process.stdout,buildId:'TEST-host-v1',
      nativeCustody:{timeoutMs:2000},methods:{
        'TEST.blocked-native':{lane:'work',handle:params=>server.nativeCustody.request(
          {operation:'write',capability:'TEST-original',bytes:'YQ=='},
          params.expire?performance.now()+20:undefined)},
        'TEST.control':{lane:'control',handle:()=>server.nativeCustody.request(
          {operation:'observe',capability:'TEST-original'})},
        'TEST.missing-budget':{lane:'control',handle:params=>{
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',
            id:'custody:'+server.handshake.hostIncarnation+':work:99',method:'host.native-custody',
            params:{binding:params.binding,call:{operation:'write',capability:'TEST-original',bytes:'Yg=='}}})+'\\n');
          return 'sent';
        }}
      }});
    void server.closed.then(()=>process.exit(0));
  `;
}
