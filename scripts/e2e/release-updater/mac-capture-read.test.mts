import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { captureMacWindow, MacCommands, macProcesses, stopMacOwned } from './mac-loopback.mts';

import type { TestContext } from 'node:test';
type MacProcess = Awaited<ReturnType<typeof macProcesses>>[number];

interface Snapshot {
  exitCode: number;
  rows: MacProcess[];
}
async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-mac-capture-read-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.mock.method(process, 'kill', () => {
    assert.fail('read/capture must never signal');
  });
  const app = path.join(root, 'Applications', 'Agent Teams AI.app');
  const owner = {
    pid: 7857,
    uid: process.getuid?.() ?? 0,
    group: 7857,
    start: 'Wed Oct 7 08:30:29 2026',
    command: `${app}/Contents/MacOS/Agent Teams AI`,
  };
  const harness = { ...owner, pid: process.pid, group: process.pid, command: process.execPath };
  const row = (entry: MacProcess) =>
    `${entry.pid} ${entry.uid} ${entry.group} ${entry.start} ${entry.command}`;
  let snapshots: Snapshot[] = [];
  const calls: string[] = [];
  class Commands extends MacCommands {
    override async run(label: string, binary: string, args: string[], timeout = 120_000) {
      calls.push(label);
      let script: string;
      if (label === 'process-identities') {
        assert.equal(binary, '/bin/ps');
        assert.deepEqual(args, ['-axww', '-o', 'pid=,uid=,pgid=,lstart=,comm=']);
        assert.equal(timeout, 1000);
        const snapshot = snapshots.shift();
        assert(snapshot, 'unexpected additional process read');
        script = `process.stdout.write(${JSON.stringify(snapshot.rows.map(row).join('\n'))});process.exit(${snapshot.exitCode});`;
      } else if (label === 'aqua-windows') {
        assert.deepEqual(args, [String(owner.pid)]);
        script = `process.stdout.write(${JSON.stringify(
          JSON.stringify([
            {
              kCGWindowOwnerPID: owner.pid,
              kCGWindowNumber: 26,
              kCGWindowBounds: { Width: 300, Height: 200 },
            },
          ])
        )});`;
      } else if (label === 'capture-aqua-window') {
        assert.equal(binary, '/usr/sbin/screencapture');
        assert(args[3]);
        script = `require('node:fs').writeFileSync(${JSON.stringify(args[3])}, Buffer.alloc(1201));`;
      } else {
        assert.equal(label, 'native-capture-pixels');
        script = `process.stdout.write('${JSON.stringify({ width: 300, height: 200, distinctColors: 32 })}');`;
      }
      // Execute only tiny Node fixtures; retain real command records and START/COMPLETE writes.
      return super.run(label, process.execPath, ['-e', script], timeout);
    }
  }
  const commands = new Commands(root);
  const capture = () => captureMacWindow(commands, 'TEST-reader-never-executed', owner, app);
  return {
    root,
    app,
    commands,
    calls,
    owner,
    harness,
    capture,
    reads: (values: Snapshot[]) => {
      snapshots = values;
    },
  };
}

void test('capture retries one COMPLETE failed ps read and retains both records before valid capture', async (context) => {
  const f = await fixture(context);
  f.reads([
    { exitCode: 128, rows: [] },
    { exitCode: 0, rows: [f.harness, f.owner] },
  ]);
  const captured = await f.capture();
  assert.deepEqual(captured.owner, f.owner);
  assert.equal(captured.pixels.distinctColors, 32);
  const reads = f.commands.commands.filter((entry) => entry.logFile.includes('process-identities'));
  assert.deepEqual(
    reads.map((entry) => entry.exitCode),
    [128, 0]
  );
  for (const entry of reads)
    assert((await readFile(path.join(f.root, entry.logFile), 'utf8')).startsWith('stdout:'));
  const markers = (await readdir(f.root)).filter(
    (name) => name.includes('process-identities') && name.endsWith('-complete.json')
  );
  assert.equal(markers.length, 2);
  for (const marker of markers) {
    const complete = JSON.parse(await readFile(path.join(f.root, marker), 'utf8')) as {
      state: string;
      timeout: number;
    };
    assert.equal(complete.state, 'COMPLETE');
    assert.equal(complete.timeout, 1000);
  }
  assert.deepEqual(f.calls, [
    'aqua-windows',
    'process-identities',
    'process-identities',
    'capture-aqua-window',
    'native-capture-pixels',
  ]);
});

void test('capture second transport failure propagates without capture or third read', async (context) => {
  const f = await fixture(context);
  f.reads([
    { exitCode: 128, rows: [] },
    { exitCode: 1, rows: [] },
  ]);
  await assert.rejects(f.capture(), /process-identities failed/);
  assert.deepEqual(f.calls, ['aqua-windows', 'process-identities', 'process-identities']);
  assert.deepEqual(
    f.commands.commands.map((entry) => entry.exitCode),
    [0, 128, 1]
  );
});

void test('successful owner and self-PID validation failures never retry or capture', async (context) => {
  for (const failedFirst of [false, true]) {
    for (const scenario of [
      'foreign-executable',
      'foreign-uid',
      'foreign-group',
      'reused-start',
      'missing',
      'missing-self',
      'malformed-owner',
    ]) {
      await context.test(`${scenario}, transport failure first ${failedFirst}`, async (child) => {
        const f = await fixture(child);
        let rows: MacProcess[];
        if (scenario === 'missing') rows = [f.harness];
        else if (scenario === 'missing-self') rows = [f.owner];
        else
          rows = [
            f.harness,
            {
              ...f.owner,
              command: scenario === 'foreign-executable' ? '/foreign/executable' : f.owner.command,
              uid: scenario === 'foreign-uid' ? f.owner.uid + 1 : f.owner.uid,
              group: scenario === 'foreign-group' ? f.owner.group + 1 : f.owner.group,
              start: scenario === 'reused-start' ? 'Wed Oct 7 08:31:29 2026' : f.owner.start,
              pid: scenario === 'malformed-owner' ? Number.NaN : f.owner.pid,
            },
          ];
        f.reads([...(failedFirst ? [{ exitCode: 128, rows: [] }] : []), { exitCode: 0, rows }]);
        await assert.rejects(f.capture());
        assert.deepEqual(f.calls, [
          'aqua-windows',
          ...Array.from({ length: failedFirst ? 2 : 1 }, () => 'process-identities'),
        ]);
      });
    }
  }
});

void test('ordinary process and cleanup callers remain fail closed on transport failure', async (context) => {
  for (const cleanup of [false, true]) {
    await context.test(`cleanup ${cleanup}`, async (child) => {
      const f = await fixture(child);
      f.reads([{ exitCode: 128, rows: [] }]);
      await assert.rejects(
        cleanup ? stopMacOwned(f.commands, f.owner, f.app) : macProcesses(f.commands),
        /process-identities failed/
      );
      assert.deepEqual(f.calls, ['process-identities']);
    });
  }
});
