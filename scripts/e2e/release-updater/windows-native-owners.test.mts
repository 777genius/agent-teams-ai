import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { uniqueWindowsOwners } from './windows-native.mts';
import { observeInstallerChild } from './windows-ota-observer.mts';
import type { WindowsProcess } from './windows-native.mts';

const owner: WindowsProcess = {
  pid: 2468,
  parent: 9856,
  executable: 'C:\\TEST-updater-windows-owned\\install\\AgentTeamsAI.exe',
  command: 'TEST-owned-app',
  start: '2026-10-07T10:42:33.6598600Z',
  session: 2,
  sid: 'TEST-owner-SID',
};
void test('initial owner plus scanned alias is signalled only once after the first stop removes its PID', () => {
  const children = [8424, 4112, 9520].map((pid) => ({ ...owner, pid, parent: owner.pid }));
  const discovered = [{ ...owner }, ...children];
  const live = new Set([owner.pid, ...children.map((child) => child.pid)]);
  const signals: number[] = [];
  // Models only the consumer list contract, not native Windows stop acceptance.
  for (const selected of uniqueWindowsOwners([owner, ...discovered])) {
    assert(live.delete(selected.pid), 'A removed PID must never be signalled again');
    signals.push(selected.pid);
  }
  assert.deepEqual(signals, [2468, 8424, 4112, 9520]);
  assert.equal(live.size, 0);
  assert.equal(discovered.length, 4);
});
for (const [field, value] of Object.entries({
  start: '2026-10-07T10:42:33.6598601Z',
  sid: 'OTHER-owner-SID',
  session: 3,
  executable: 'C:\\TEST-updater-windows-other\\install\\AgentTeamsAI.exe',
})) {
  void test(
    'same PID with changed ' + field + ' rejects the entire batch before any signal',
    () => {
      const signals: number[] = [];
      assert.throws(() => {
        for (const selected of uniqueWindowsOwners([owner, { ...owner, [field]: value }])) {
          signals.push(selected.pid);
        }
      }, /Conflicting TEST PID identity/u);
      assert.deepEqual(signals, []);
    }
  );
}
void test('empty owner list stays empty and invalid PIDs fail before preparing a signal', () => {
  assert.deepEqual(uniqueWindowsOwners([]), []);
  assert.throws(() => uniqueWindowsOwners([{ ...owner, pid: 0 }]), /Invalid TEST PID/u);
});
void test('real portable child events retain spawn PID and nonzero exit without adopting missing identity', async () => {
  const records: unknown[] = [];
  const child = spawn(process.execPath, ['-e', 'process.exit(7)'], { env: {}, stdio: 'ignore' });
  const finish = observeInstallerChild(
    child,
    process.execPath,
    {
      processes: () => Promise.resolve([]),
      installerLineage: () =>
        Promise.reject(new Error('Exited child must not be inspected at25seconds')),
    },
    (receipt) => {
      records.push(structuredClone(receipt));
      return Promise.resolve();
    }
  );
  await once(child, 'exit');
  await finish();
  const record = records.at(-1) as {
    qualifying: boolean;
    identity: unknown;
    lineage: unknown;
    closeObserved: boolean;
    events: { event: string; pid?: number; code?: number; signal?: string | null }[];
  };
  assert.equal(record.qualifying, false);
  assert.equal(record.identity, null);
  assert.equal(record.lineage, null);
  assert.equal(record.events.find((event) => event.event === 'spawn')?.pid, child.pid);
  assert.equal(record.events.find((event) => event.event === 'exit')?.code, 7);
  assert.equal(record.events.find((event) => event.event === 'exit')?.signal, null);
  assert.equal(
    record.closeObserved,
    record.events.some((event) => event.event === 'close')
  );
  assert(record.events.some((event) => event.event === 'observation-finalized'));
});
void test('failed portable spawn records the error and never queries an undefined installer PID', async () => {
  const records: unknown[] = [];
  const child = spawn('/TEST-nonexistent-installer-observer', [], { env: {}, stdio: 'ignore' });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const unavailable = (): Promise<never> =>
    Promise.reject(new Error('No spawn means no native query'));
  const finish = observeInstallerChild(
    child,
    '/TEST-nonexistent-installer-observer',
    {
      processes: unavailable,
      installerLineage: unavailable,
    },
    (receipt) => {
      records.push(structuredClone(receipt));
      return Promise.resolve();
    }
  );
  await closed;
  await finish();
  const record = records.at(-1) as {
    identity: unknown;
    diagnosticError: unknown;
    events: { event: string; error?: string }[];
  };
  assert.equal(record.identity, null);
  assert.equal(record.diagnosticError, null);
  assert(!record.events.some((event) => event.event === 'spawn'));
  assert.match(record.events.find((event) => event.event === 'error')?.error ?? '', /ENOENT/u);
});
