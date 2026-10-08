import assert from 'node:assert/strict';
import { test } from 'node:test';

import { digest } from '../../ci/release/contract.ts';
import { MacCommands, stopMacOwned } from './mac-loopback.mts';

import type { TestContext } from 'node:test';

const app = '/TEST-mac-current-fixture/Applications/Agent Teams AI.app';
const owner = {
  pid: 7857,
  uid: 501,
  group: 7857,
  start: 'Wed Oct 7 08:30:29 2026',
  command: `${app}/Contents/MacOS/Agent Teams AI`,
};
const helper = `${app}/Contents/Frameworks/Agent Teams AI Helper.app/Contents/MacOS/Agent Teams AI Helper`;
const row = (entry: typeof owner) =>
  `${entry.pid} ${entry.uid} ${entry.group} 1 S ${entry.start} ${entry.command}`;
const main = row(owner);
const helperRow = (command: string) => row({ ...owner, pid: 7908, command });

function fixture(context: TestContext, read: (signals: string[]) => string[]) {
  const signals: string[] = [];
  context.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
    assert.equal(pid, -owner.group);
    assert(signal === 'SIGTERM' || signal === 'SIGKILL');
    signals.push(signal);
    return true;
  });
  class Commands extends MacCommands {
    override run(label: string, binary: string, args: string[]) {
      assert.equal(label, 'process-identities');
      assert.equal(binary, '/bin/ps');
      assert.deepEqual(args, ['-axww', '-o', 'pid=,uid=,pgid=,ppid=,stat=,lstart=,comm=']);
      const rows = read(signals);
      const harness = row({
        ...owner,
        pid: process.pid,
        uid: process.getuid?.() ?? 0,
        group: process.pid,
        command: process.execPath,
      });
      const stdout = [harness, ...rows].join('\n');
      return Promise.resolve({
        command: binary,
        exitCode: 0,
        stdout,
        stderr: '',
        outputSha256: digest(stdout),
        logFile: 'TEST-process-snapshot.log',
      });
    }
  }
  return { commands: new Commands('/TEST-no-native-execution'), signals };
}

void test('captured post-TERM defunct/argv fallback remains present until actual absence', async (context) => {
  // Both authenticated ARM/x64 archives have this presentation sequence.
  const newHelper = { ...owner, pid: 8215, start: 'Wed Oct 7 08:30:50 2026', command: helper };
  const snapshots = [
    [main, helperRow(helper)],
    [main, helperRow('<defunct>')],
    [main, row(newHelper)],
    [
      row({ ...owner, command: '(Agent Teams AI)' }),
      row({ ...newHelper, command: '(Agent Teams AI H)' }),
    ],
    [],
  ];
  const { commands, signals } = fixture(context, () => snapshots.shift() ?? []);
  const stopped = await stopMacOwned(commands, owner, app);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.deepEqual(stopped.before, [owner, { ...owner, pid: 7908, command: helper }]);
  assert.deepEqual(stopped.remaining, []);
});

void test('forced stop still requires fresh full ownership and waits through argv fallback', async (context) => {
  let forcedReads = 0;
  const { commands, signals } = fixture(context, (sent) => {
    if (!sent.includes('SIGKILL')) return [main, helperRow(helper)];
    return forcedReads++ === 0
      ? [row({ ...owner, command: '(Agent Teams AI)' }), helperRow('<defunct>')]
      : [];
  });
  const stopped = await stopMacOwned(commands, owner, app);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(stopped.remaining, []);
});

void test('foreign and reused identities reject before TERM or KILL', async (context) => {
  const unsafe = [
    ['foreign group member', [main, row({ ...owner, pid: 7908, command: '/foreign/executable' })]],
    ['reused main PID', [row({ ...owner, start: 'Wed Oct 7 08:31:29 2026' })]],
  ] as const;
  for (const stage of ['TERM', 'KILL'] as const) {
    for (const [name, rows] of unsafe) {
      await context.test(`${name} before ${stage}`, async (child) => {
        const { commands, signals } = fixture(child, (sent) =>
          stage === 'TERM' || sent.length ? [...rows] : [main, helperRow(helper)]
        );
        await assert.rejects(
          stopMacOwned(commands, owner, app),
          name === 'foreign group member' ? /foreign process/ : /identity changed/
        );
        assert.deepEqual(signals, stage === 'TERM' ? [] : ['SIGTERM']);
      });
    }
  }
});
