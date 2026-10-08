import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MacCommands,
  macSmokeCustody,
  stopMacSmokeCustody,
  stopMacOwned,
  activeMacProcess,
  macOwnedForeground,
  type MacProcessSnapshot,
} from './mac-loopback.mts';
const app = '/TEST-owned/App.app',
  uid = process.getuid?.() ?? 0;
const started = new Date('2026-10-08T14:02:00').getTime();
const leader: MacProcessSnapshot = {
  pid: 24769,
  uid,
  group: 24769,
  parentPid: 10,
  state: 'S',
  start: 'Thu Oct 8 14:02:00 2026',
  command: app + '/Contents/MacOS/App',
};
const detached = { ...leader, pid: 25031, group: 25031, parentPid: leader.pid };
const observed = [
  { process: leader },
  { process: detached },
  { process: { ...detached, parentPid: 1 } },
];
void test('captured detached descendant is stopped after original smoke group disappears', async (context) => {
  let rows = [{ ...detached, parentPid: 1 }];
  const signals: number[] = [];
  context.mock.method(process, 'kill', (pid: number) => {
    signals.push(pid);
    rows = rows.filter((item) => item.pid !== pid);
    return true;
  });
  class Commands extends MacCommands {
    override run() {
      return Promise.resolve({
        command: 'TEST ps',
        exitCode: 0,
        stdout: [
          `${process.pid} ${uid} ${process.pid} 1 S Thu Oct 8 14:02:00 2026 ${process.execPath}`,
          ...rows.map(
            (item) =>
              `${item.pid} ${item.uid} ${item.group} ${item.parentPid} ${item.state} ${item.start} ${item.command}`
          ),
        ].join('\n'),
        stderr: '',
        outputSha256: '',
        logFile: 'TEST',
      });
    }
  }
  const commands = new Commands('/TEST-no-write');
  if (process.env.TEST_BASELINE_GROUP_ONLY === '1') await stopMacOwned(commands, leader, app);
  else
    await stopMacSmokeCustody(
      commands,
      macSmokeCustody(observed, leader.pid, app, uid, started, started + 1000, []),
      app
    );
  assert.deepEqual(signals, [detached.pid]);
  assert.equal(rows.filter(activeMacProcess).length, 0);
});
void test('detached role requires exact verified profile; unknown, wrong UID/path/start/group and reused PID reject', () => {
  const profile = '/TEST-smoke/user-data';
  const orphan = { ...detached, parentPid: 1 };
  assert.equal(
    macSmokeCustody(
      [{ process: leader }, { process: orphan, crashpadDatabase: profile + '/Crashpad' }],
      leader.pid,
      app,
      uid,
      started,
      started + 1000,
      [profile]
    ).length,
    2
  );
  for (const bad of [
    { ...orphan },
    { ...orphan, uid: uid + 1 },
    { ...orphan, command: '/foreign/App' },
    { ...orphan, start: 'Thu Oct 8 14:01:00 2026' },
    { ...orphan, group: leader.group + 1 },
  ])
    assert.throws(() =>
      macSmokeCustody(
        [{ process: leader }, { process: bad }],
        leader.pid,
        app,
        uid,
        started,
        started + 1000,
        []
      )
    );
  assert.throws(
    () =>
      macSmokeCustody(
        [...observed, { process: { ...detached, start: 'Thu Oct 8 14:02:01 2026' } }],
        leader.pid,
        app,
        uid,
        started,
        started + 2000,
        []
      ),
    /identity changed/
  );
});
void test('full identity is rechecked before any targeted signal', async (context) => {
  context.mock.method(process, 'kill', () =>
    assert.fail('foreign or reused PID must not receive signal')
  );
  for (const change of [
    { uid: uid + 1 },
    { group: 123 },
    { command: '/foreign/App' },
    { start: 'Thu Oct 8 14:02:01 2026' },
    { parentPid: 444 },
  ]) {
    const item = { ...detached, ...change };
    class Commands extends MacCommands {
      override run() {
        return Promise.resolve({
          command: 'TEST ps',
          exitCode: 0,
          stdout: `${process.pid} ${uid} ${process.pid} 1 S Thu Oct 8 14:02:00 2026 ${process.execPath}\n${item.pid} ${item.uid} ${item.group} ${item.parentPid} S ${item.start} ${item.command}`,
          stderr: '',
          outputSha256: '',
          logFile: 'TEST',
        });
      }
    }
    await assert.rejects(
      stopMacSmokeCustody(new Commands('/TEST-no-write'), [detached], app),
      /identity changed/
    );
  }
});

void test('OS notification focus theft reactivates exact owned PID; replacement rejects', async () => {
  let reads = 0,
    replaced = false;
  class Commands extends MacCommands {
    override run(label: string, _binary: string, args: string[]) {
      let stdout: string;
      if (label === 'process-identities')
        stdout = `${process.pid} ${uid} ${process.pid} 1 S Thu Oct 8 14:02:00 2026 ${process.execPath}\n${leader.pid} ${uid} ${leader.group} 10 S ${replaced ? 'Thu Oct 8 14:03:00 2026' : leader.start} ${leader.command}`;
      else {
        assert.deepEqual(args, [String(leader.pid), leader.command]);
        stdout = JSON.stringify(
          reads++ === 0
            ? {
                pid: 10398,
                executable:
                  '/System/Library/CoreServices/UserNotificationCenter.app/Contents/MacOS/UserNotificationCenter',
              }
            : { pid: leader.pid, executable: leader.command }
        );
      }
      return Promise.resolve({
        command: 'TEST',
        exitCode: 0,
        stdout,
        stderr: '',
        outputSha256: '',
        logFile: 'TEST',
      });
    }
  }
  const commands = new Commands('/TEST-no-write');
  const identity = {
    pid: leader.pid,
    uid: leader.uid,
    group: leader.group,
    start: leader.start,
    command: leader.command,
  };
  assert.deepEqual(await macOwnedForeground(commands, identity, '/TEST-frontmost'), {
    pid: leader.pid,
    executable: leader.command,
  });
  replaced = true;
  await assert.rejects(
    macOwnedForeground(commands, identity, '/TEST-frontmost'),
    /identity changed/
  );
});

void test('post-TERM unknown presentation or reused captured PID remains blocking and cannot receive KILL', async (context) => {
  for (const reuse of [false, true]) await context.test(String(reuse), async (child) => {
    let signaled = false;
    const signals: string[] = [];
    child.mock.method(process, 'kill', (_pid: number, signal: string) => { signals.push(signal); signaled = true; return true; });
    class Commands extends MacCommands {
      override run() {
        const item = signaled ? { ...detached, state: '?<E', command: '(Agent Teams AI)', start: reuse ? 'Thu Oct 8 14:02:01 2026' : detached.start } : detached;
        return Promise.resolve({ command: 'TEST ps', exitCode: 0, stdout: `${process.pid} ${uid} ${process.pid} 1 S Thu Oct 8 14:02:00 2026 ${process.execPath}\n${item.pid} ${item.uid} ${item.group} ${item.parentPid} ${item.state} ${item.start} ${item.command}`, stderr: '', outputSha256: '', logFile: 'TEST' });
      }
    }
    await assert.rejects(stopMacSmokeCustody(new Commands('/TEST-no-write'), [detached], app), /identity changed/);
    assert.deepEqual(signals, ['SIGTERM']);
  });
});
