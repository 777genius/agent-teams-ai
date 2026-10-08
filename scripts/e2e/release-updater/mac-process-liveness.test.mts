import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activeMacProcess,
  parseMacProcessSnapshot,
  MacCommands,
  stopMacOwned,
} from './mac-loopback.mts';

// Red if executing survivors are hidden or zombie state is inferred from path/group instead of ps state.
void test('native snapshot preserves exact identity and excludes only proven Z/X states', () => {
  const rows = parseMacProcessSnapshot(
    '60018 501 60018 1 Z Thu Oct 8 12:26:21 2026 /TEST-owned/Agent Teams AI.app/Contents/MacOS/Agent Teams AI\n60583 501 60583 45409 S+ Thu Oct 8 12:26:35 2026 /TEST-owned/Agent Teams AI.app/Contents/MacOS/Agent Teams AI'
  );
  assert.deepEqual(rows[0], {
    pid: 60018,
    uid: 501,
    group: 60018,
    parentPid: 1,
    state: 'Z',
    start: 'Thu Oct 8 12:26:21 2026',
    command: '/TEST-owned/Agent Teams AI.app/Contents/MacOS/Agent Teams AI',
  });
  assert.equal(activeMacProcess(rows[0]), false);
  for (const state of ['R', 'S+', 'T', 'U', 'I'])
    assert.equal(activeMacProcess({ ...rows[0], state }), true);
  assert.equal(activeMacProcess({ ...rows[0], state: 'X' }), false);
  assert.throws(
    () => parseMacProcessSnapshot('60018 501 60018 1 ? Thu Oct 8 12:26:21 2026 /TEST-owned/app'),
    /Invalid native process state/
  );
});

void test('zombie-only owned group requires no signals; live foreign group still rejects before signaling', async (context) => {
  context.mock.method(process, 'kill', () => assert.fail('must not signal'));
  const uid = process.getuid?.() ?? 0;
  const owner = {
    pid: 60018,
    uid,
    group: 60018,
    start: 'Thu Oct 8 12:26:21 2026',
    command: '/TEST-owned/App.app/Contents/MacOS/App',
  };
  let state = 'Z';
  let command = owner.command;
  class Commands extends MacCommands {
    override run() {
      return Promise.resolve({
        command: 'TEST ps',
        exitCode: 0,
        stdout: `${process.pid} ${uid} ${process.pid} 1 S Thu Oct 8 12:26:20 2026 ${process.execPath}\n60018 ${uid} 60018 1 ${state} ${owner.start} ${command}`,
        stderr: '',
        outputSha256: '',
        logFile: 'TEST',
      });
    }
  }
  const commands = new Commands('/TEST-no-write');
  assert.deepEqual(await stopMacOwned(commands, owner, '/TEST-owned/App.app'), {
    before: [],
    remaining: [],
  });
  state = 'S';
  command = '/foreign/App';
  await assert.rejects(
    stopMacOwned(commands, owner, '/TEST-owned/App.app'),
    /Owned main PID identity changed/
  );
});
