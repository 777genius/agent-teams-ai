import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createWindowsJobCustodyForKernel } from '../dist/adapters/providers/WindowsJobCustody.js';
import { createWindowsJobKernel } from '../dist/adapters/providers/WindowsJobKernel.js';
import { CapturedProcess } from '../dist/adapters/providers/CapturedProcess.js';
import type { WindowsHandle, WindowsJobKernel } from '../dist/adapters/providers/WindowsJobKernel.js';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-windows-job-')));
  const file = path.join(root, 'TEST-executable');
  await writeFile(file, 'TEST exact executable');
  const executable = { path: file, sha256: createHash('sha256').update('TEST exact executable').digest('hex') };
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 4107, writable: true });
  const processHandle = {}, jobHandle = {}, calls: { name: string; handle?: WindowsHandle; pid?: number }[] = [];
  const state = { live: true, active: 1, birth: '132000000001234567', member: true,
    queryError: false, terminateError: false, closeError: false, assignError: false };
  const kernel: WindowsJobKernel = {
    openProcess(pid) { calls.push({ name: 'open', pid }); return processHandle; },
    createJob() { calls.push({ name: 'create' }); return jobHandle; },
    assign(job, process) {
      assert.equal(job, jobHandle); assert.equal(process, processHandle);
      calls.push({ name: 'assign', handle: job });
      if (state.assignError) throw new Error('TEST assignment refused');
    },
    isMember(job, process) { assert.equal(job, jobHandle); assert.equal(process, processHandle); return state.member; },
    readProcess(handle) {
      assert.equal(handle, processHandle); calls.push({ name: 'read', handle });
      return { pid: 4107, startIdentity: state.birth, executablePath: file };
    },
    alive(handle) { assert.equal(handle, processHandle); return state.live; },
    activeProcesses(handle) {
      assert.equal(handle, jobHandle); calls.push({ name: 'query', handle });
      if (state.queryError) throw new Error('TEST query failed');
      return state.active;
    },
    terminate(handle) {
      assert.equal(handle, jobHandle); calls.push({ name: 'terminate', handle });
      if (state.terminateError) throw new Error('TEST lost terminate result');
    },
    close(handle) {
      assert.ok(handle === processHandle || handle === jobHandle);
      calls.push({ name: 'close', handle });
      if (state.closeError) throw new Error('TEST close result unknown');
    },
  };
  return { root, executable, child, state, calls, kernel, processHandle, jobHandle,
    source: createWindowsJobCustodyForKernel(kernel) };
}

test('original Windows handles retain birth and executable identity without any later PID lookup', async () => {
  const f = await fixture();
  try {
    const tree = f.source.capture(f.child, f.executable);
    Object.defineProperty(f.child, 'pid', { value: 9201 });
    assert.deepEqual(tree.readExecutable(), { executablePath: f.executable.path,
      executableSha256: f.executable.sha256, pid: 4107, startIdentity: f.state.birth });
    assert.equal(tree.observe(), 'present');
    assert.deepEqual(f.calls.filter(row => row.name === 'open'), [{ name: 'open', pid: 4107 }]);
    assert.throws(() => f.source.capture(f.child, f.executable), /custody unavailable/);
    f.state.birth = '132000000001234568';
    assert.throws(() => tree.readExecutable(), /custody unavailable/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('same-name executable replacement cannot satisfy retained Windows process custody', async () => {
  const f = await fixture();
  try {
    const tree = f.source.capture(f.child, f.executable);
    await writeFile(f.executable.path, 'TEST replacement bytes');
    assert.throws(() => tree.readExecutable(), /custody unavailable/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('Windows job owns descendants after root exit and closes both handles only after complete absence', async () => {
  const f = await fixture();
  try {
    const tree = f.source.capture(f.child, f.executable);
    f.state.live = false; f.state.active = 2;
    assert.equal(tree.observe(), 'present');
    assert.equal(f.calls.some(row => row.name === 'close'), false);
    tree.terminate(); tree.terminate();
    assert.deepEqual(f.calls.filter(row => row.name === 'terminate'), [{ name: 'terminate', handle: f.jobHandle }]);
    f.state.active = 0;
    assert.equal(tree.observe(), 'absent');
    assert.deepEqual(f.calls.filter(row => row.name === 'close').map(row => row.handle), [f.processHandle, f.jobHandle]);
    const count = f.calls.length;
    assert.equal(tree.observe(), 'absent'); tree.terminate();
    assert.equal(f.calls.length, count, 'retired handles are never touched again');
    assert.throws(() => tree.readExecutable(), /custody unavailable/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('native Windows errors and malformed accounting stay unknown and do not replay termination', async () => {
  const f = await fixture();
  try {
    const tree = f.source.capture(f.child, f.executable);
    f.state.queryError = true;
    assert.equal(tree.observe(), 'unknown');
    f.state.queryError = false;
    for (const active of [-1, 0.5, NaN, Infinity, 2 ** 32]) {
      f.state.active = active; assert.equal(tree.observe(), 'unknown');
    }
    f.state.active = 0;
    assert.equal(tree.observe(), 'unknown', 'live original root cannot be absent from its job');
    assert.equal(f.calls.some(row => row.name === 'close'), false);
    f.state.terminateError = true;
    assert.throws(() => tree.terminate(), /lost terminate result/);
    tree.terminate();
    assert.equal(f.calls.filter(row => row.name === 'terminate').length, 1);
    f.state.live = false;
    assert.equal(tree.observe(), 'absent', 'fresh physical absence can settle unknown termination');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a failed native close never retries a possibly recycled handle or claims cleanup', async () => {
  const f = await fixture();
  try {
    const tree = f.source.capture(f.child, f.executable);
    f.state.live = false; f.state.active = 0; f.state.closeError = true;
    assert.equal(tree.observe(), 'unknown');
    assert.equal(f.calls.filter(row => row.name === 'close').length, 2);
    const count = f.calls.length;
    assert.equal(tree.observe(), 'unknown'); tree.terminate();
    assert.equal(f.calls.length, count);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('failed Windows job assignment rejects original capture and never adopts the PID on retry', async () => {
  const f = await fixture();
  try {
    f.state.assignError = true;
    assert.throws(() => f.source.capture(f.child, f.executable), /assignment refused/);
    assert.deepEqual(f.calls.filter(row => row.name === 'close').map(row => row.handle), [f.jobHandle, f.processHandle]);
    f.state.assignError = false;
    assert.throws(() => f.source.capture(f.child, f.executable), /custody unavailable/);
    assert.equal(f.calls.filter(row => row.name === 'open').length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('kernel32 binding uses noninheritable opaque handles and a non-breakaway job with native accounting', () => {
  const processHandle = {}, jobHandle = {};
  const calls: { funcName: string; paramsValue: unknown[]; paramsType: unknown[] }[] = [];
  let wait = 258, returnedLength = 48;
  const kernel = createWindowsJobKernel({
    open(value: unknown) { assert.deepEqual(value, { library: 'TEST-job', path: 'kernel32.dll' }); },
    isNullPointer() { return false; },
    load(input: { funcName: string; paramsValue: unknown[]; paramsType: unknown[] }) {
      calls.push(input);
      const buffer = (index: number) => { const value = input.paramsValue[index]; assert.ok(Buffer.isBuffer(value)); return value; };
      switch (input.funcName) {
        case 'OpenProcess': assert.deepEqual(input.paramsValue, [0x101101, 0, 4107]); return processHandle;
        case 'CreateJobObjectW': assert.deepEqual(input.paramsValue, [0, 0]); return jobHandle;
        case 'SetInformationJobObject': {
          assert.equal(buffer(2).length, 144);
          const expected = Buffer.alloc(144); expected.writeUInt32LE(0x2000, 16);
          assert.deepEqual(buffer(2), expected); return 1;
        }
        case 'GetProcessId': return 4107;
        case 'GetProcessTimes': buffer(1).writeBigUInt64LE(132000000001234567n); return 1;
        case 'QueryFullProcessImageNameW': {
          const name = 'C:\\TEST\\bun.exe'; buffer(2).write(name, 'utf16le'); buffer(3).writeUInt32LE(name.length); return 1;
        }
        case 'IsProcessInJob': buffer(2).writeInt32LE(1); return 1;
        case 'WaitForSingleObject': return wait;
        case 'QueryInformationJobObject': buffer(2).writeUInt32LE(3, 40); buffer(4).writeUInt32LE(returnedLength); return 1;
        default: return 1;
      }
    },
  }, 'TEST-job');
  assert.equal(kernel.openProcess(4107), processHandle);
  assert.equal(kernel.createJob(), jobHandle);
  kernel.assign(jobHandle, processHandle);
  assert.equal(kernel.isMember(jobHandle, processHandle), true);
  assert.deepEqual(kernel.readProcess(processHandle), { pid: 4107, startIdentity: '132000000001234567', executablePath: 'C:\\TEST\\bun.exe' });
  assert.equal(kernel.alive(processHandle), true);
  assert.equal(kernel.activeProcesses(jobHandle), 3);
  wait = 0; assert.equal(kernel.alive(processHandle), false);
  wait = 0xffff_ffff; assert.throws(() => kernel.alive(processHandle), /custody unavailable/);
  returnedLength = 4; assert.throws(() => kernel.activeProcesses(jobHandle), /custody unavailable/);
  kernel.terminate(jobHandle); kernel.close(processHandle); kernel.close(jobHandle);
  assert.ok(calls.every(row => ['CreateJobObjectW', 'OpenProcess'].includes(row.funcName)
    || row.paramsType[0] === 11), 'all live HANDLE arguments remain opaque External values');
});

test('required tree capture fails before private stdin and retains the failed original child as unknown',
  { timeout: 15_000 }, async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-required-tree-')));
    const executable = { path: await realpath(process.execPath),
      sha256: createHash('sha256').update(await readFile(await realpath(process.execPath))).digest('hex') };
    let original: ChildProcess | undefined;
    const owner = new CapturedProcess({ provider: 'opencode', cwd: root, executable,
      environment: { HOME: root, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } },
    () => true, undefined, () => true, { capture(child) {
      original = child;
      throw new Error('TEST required capture refused');
    } });
    try {
      assert.throws(() => owner.launch({ command: executable.path, cwd: root,
        args: ['--input-type=module', '-e',
          'import {writeFileSync} from "node:fs";process.stdin.on("data",()=>writeFileSync("TEST-effect","unsafe"));process.stdin.resume();'] }),
      /Native process tree unavailable/);
      assert.ok(original);
      if (original.exitCode === null && original.signalCode === null) await once(original, 'exit');
      await assert.rejects(access(path.join(root, 'TEST-effect')), { code: 'ENOENT' });
      assert.equal(await owner.confirmStopped(), false, 'root exit cannot repair missing native tree capture');
      assert.throws(() => owner.launch({ command: executable.path, cwd: root, args: [] }), /unavailable/);
    } finally {
      if (original?.exitCode === null && original.signalCode === null) original.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  });

test('fresh observations of a retained original tree use owned lifetime, not the allocation gate',
  { timeout: 15_000 }, async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-owned-tree-')));
    const executable = { path: await realpath(process.execPath),
      sha256: createHash('sha256').update(await readFile(await realpath(process.execPath))).digest('hex') };
    let allocation = true, current = true;
    const owner = new CapturedProcess({ provider: 'opencode', cwd: root, executable,
      environment: { HOME: root, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } },
    () => allocation, undefined, () => current, { capture(child) {
      return { readExecutable: () => ({ executablePath: executable.path, executableSha256: executable.sha256,
        pid: child.pid!, startIdentity: 'TEST-captured' }),
      observe: () => child.exitCode !== null || child.signalCode !== null ? 'absent' : 'present',
      terminate: () => { child.kill(); } };
    } });
    const child = owner.launch({ command: executable.path, cwd: root,
      args: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))'] });
    child.stdin.on('error', () => {});
    try {
      allocation = false;
      assert.equal(owner.readNativeExecutable(child).pid, child.pid);
      current = false;
      assert.throws(() => owner.readNativeExecutable(child), /observation unavailable/);
      current = true;
      child.stdin.end();
      assert.equal(await owner.confirmStopped(), true);
      assert.throws(() => owner.readNativeExecutable(child), /observation unavailable/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  });
