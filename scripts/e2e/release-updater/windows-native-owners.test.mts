import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uniqueWindowsOwners } from './windows-native.mts';
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
