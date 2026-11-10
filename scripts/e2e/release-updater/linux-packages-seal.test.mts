import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import {
  assertRuntimeSeal,
  decodeProcCommand,
  exactSealedCommand,
  packageLaunchSeal,
  profileDisposition,
} from './linux-packages-seal.mts';
import type { RuntimeLaunch } from './linux-packages-seal.mts';

// Captured Deb diagnostic567: Chromium title retains the original command,
// but kernel HOME/AGENT markers disappear. This is a policy contract, not OTA.
const fixtureRoot = path.join(os.tmpdir(), 'TEST-linux-deb-jjUjWA');
const roots = {
  home: path.join(fixtureRoot, 'home'),
  userData: path.join(fixtureRoot, 'user-data'),
};
const expected = {
  ...roots,
  executable: '/opt/Agent-Teams-AI/agent-teams-ai',
  inspectorPort: 40315,
  rendererPort: 34755,
};
const command = [
  expected.executable,
  '--inspect-brk=127.0.0.1:40315',
  '--remote-debugging-port=34755',
  '--remote-debugging-address=127.0.0.1',
  '--lang=en-US',
  `--user-data-dir=${roots.userData}`,
];
// Synthetic runtime observation deliberately differs from kernel argv. Actual
// argv/execArgv/versions are captured from the verified original app at runtime.
const runtime: RuntimeLaunch = {
  pid: 106,
  argv: [expected.executable, '--lang=en-US'],
  execArgv: ['--inspect-brk=127.0.0.1:40315'],
  home: roots.home,
  profile: roots.userData,
  versions: { electron: 'TEST-old', chrome: 'TEST-old', node: 'TEST-old' },
};
const seal = packageLaunchSeal(command, runtime, expected);

await test('kernel decoder preserves empty argv and requires exactly observed termination', () => {
  const vector = command.join('\0') + '\0';
  const joined = command.join(' ') + '\0';
  assert.deepEqual(decodeProcCommand(vector), command);
  assert.deepEqual(decodeProcCommand(joined), [command.join(' ')]);
  assert(exactSealedCommand(decodeProcCommand(vector) ?? [], seal));
  assert(exactSealedCommand(decodeProcCommand(joined) ?? [], seal));
  for (const raw of [
    vector.replace('\0', '\0\0'),
    vector + '\0',
    joined + '\0',
    '\0' + vector,
    vector.slice(0, -1),
    joined.slice(0, -1),
    '',
  ])
    assert.equal(exactSealedCommand(decodeProcCommand(raw) ?? [], seal), false);
});

await test('observed Chromium representation is only provisional until exact runtime ownership', () => {
  assert(exactSealedCommand(command, seal));
  assert(exactSealedCommand([command.join(' ')], seal));
  assert.equal(profileDisposition({}, roots), 'provisional');
  assert.throws(() => assertRuntimeSeal({ ...runtime, pid: 567, home: undefined }, seal, 567));
  assertRuntimeSeal({ ...runtime, pid: 567 }, seal, 567);
});
await test('present conflicting markers cannot be replaced by command proof', () => {
  assert.equal(
    profileDisposition(
      { HOME: roots.home, AGENT_TEAMS_ELECTRON_USER_DATA_DIR: roots.userData },
      roots
    ),
    'kernel-profile'
  );
  assert.equal(profileDisposition({ HOME: roots.home }, roots), 'provisional');
  for (const markers of [
    { HOME: '' },
    { HOME: '/home/other' },
    { AGENT_TEAMS_ELECTRON_USER_DATA_DIR: path.join(os.tmpdir(), 'TEST-other', 'user-data') },
  ])
    assert.equal(profileDisposition(markers, roots), 'conflict');
});
await test('exact argv/title comparison rejects independent unsafe representations', () => {
  const wrong = [
    [...command, `--user-data-dir=${path.join(os.tmpdir(), 'TEST-other', 'user-data')}`],
    [...command, command[5] ?? ''],
    [...command, '--type=zygote'],
    [command.join(' ') + ' --type=zygote'],
    [command.join(' ') + ' --type=renderer'],
    [command.join(' ') + ' --type=relauncher'],
    [command.join(' ') + ' --no-sandbox'],
    [...command, '--no-sandbox=true'],
    [command.join(' ').replace('40315', '40316')],
    [command.join(' ').replace('127.0.0.1', '0.0.0.0')],
    [command.join(' ').replace('--lang=en-US', '--lang=ru')],
    [' ' + command.join(' ')],
    [command.join(' ') + ' '],
    [command.join(' ').replace(' --lang', '  --lang')],
    ['unrelated', command.join(' ')],
    [command.join(' ').replace('TEST-linux-deb-jjUjWA', 'TEST-linux-deb-other')],
  ];
  for (const candidate of wrong) assert.equal(exactSealedCommand(candidate, seal), false);
});
await test('seal refuses ambiguous, duplicate or unobserved command tokens', () => {
  for (const token of ['', 'two words', 'a\tb', 'a\nb', 'a\0b'])
    assert.throws(() => packageLaunchSeal([token, ...command.slice(1)], runtime, expected));
  assert.throws(() => packageLaunchSeal([...command, command[5] ?? ''], runtime, expected));
  assert.throws(() =>
    packageLaunchSeal([...command.slice(1), command[0] ?? ''], runtime, expected)
  );
  assert.throws(() => packageLaunchSeal(command, { ...runtime, home: '/home/other' }, expected));
});
await test('runtime arrays remain separate actual observations with exact equality', () => {
  assert.notDeepEqual(seal.command, seal.runtime.argv);
  assertRuntimeSeal({ ...runtime, pid: 567 }, seal, 567);
  for (const actual of [
    { ...runtime, pid: 568 },
    { ...runtime, pid: 567, profile: path.join(os.tmpdir(), 'TEST-other', 'user-data') },
    { ...runtime, pid: 567, argv: command },
    { ...runtime, pid: 567, execArgv: [] },
    { ...runtime, pid: 567, argv: [...runtime.argv, '--type=renderer'] },
  ])
    assert.throws(() => assertRuntimeSeal(actual, seal, 567));
});
await test('seal snapshots are detached from mutable launch observations', () => {
  const raw = {
    ...runtime,
    argv: [...runtime.argv],
    execArgv: [...runtime.execArgv],
    versions: { ...runtime.versions },
  };
  const argv = [...command];
  const frozen = packageLaunchSeal(argv, raw, expected);
  argv[0] = '/other';
  raw.argv[0] = '/other';
  raw.execArgv.length = 0;
  assert(exactSealedCommand(command, frozen));
  assertRuntimeSeal({ ...runtime, pid: 567 }, frozen, 567);
});
