import assert from 'node:assert/strict';
import { test } from 'node:test';

import { windowsOtaSuccessor } from './windows-ota-successor.mts';

import type { WindowsProcess } from './windows-native.mts';

const executable = 'C:\\TEST-updater-windows-owned\\install\\AgentTeamsAI.exe';
const predecessor: WindowsProcess = {
  pid: 4660,
  parent: 5564,
  executable,
  command: `"${executable}" --type=renderer`,
  start: '2026-10-08T20:24:58.0000000Z',
  session: 2,
  sid: 'TEST-owner-SID',
};
const successor = {
  ...predecessor,
  parent: 7780,
  start: '2026-10-08T20:30:14.2679610Z',
  command: `"${executable}" --updated`,
};

// Red with PID-only exclusion: the genuine --updated main reuses an old child's PID.
void test('NSIS successor can reuse a prior renderer PID while the new MCP child is ignored', () => {
  const mcp = {
    ...successor,
    pid: 7436,
    parent: successor.pid,
    command: `${executable} C:\\TEST-profile\\mcp-server\\2.17.10\\index.js --transport httpStream`,
  };
  assert.equal(windowsOtaSuccessor([mcp, successor], [predecessor], executable), successor);
});
void test('unchanged PID start and executable cannot be adopted as a new successor', () => {
  assert.equal(windowsOtaSuccessor([successor], [{ ...successor }], executable), null);
  assert.equal(
    windowsOtaSuccessor(
      [successor],
      [{ ...successor, executable: executable.toUpperCase() }],
      executable
    ),
    null
  );
});
void test('new PIDs without an actual updated main stay pending, including child flags', () => {
  for (const command of [
    `"${executable}"`,
    `"${executable}" --updated-extra`,
    `"${executable}" --type=renderer --updated`,
    `"${executable}" --type utility --updated`,
    `"${executable}" C:\\TEST-profile\\mcp-server\\index.js --updated`,
    `"${executable}" --transport httpStream --updated`,
  ])
    assert.equal(windowsOtaSuccessor([{ ...successor, command }], [], executable), null);
});
void test('an updated process at another executable cannot qualify', () => {
  assert.equal(
    windowsOtaSuccessor(
      [{ ...successor, executable: 'C:\\unowned\\AgentTeamsAI.exe' }],
      [],
      executable
    ),
    null
  );
});
void test('two distinct updated main identities fail rather than choosing an arbitrary window', () => {
  assert.throws(
    () => windowsOtaSuccessor([successor, { ...successor, pid: 8424 }], [], executable),
    /Ambiguous automatic Windows successor/u
  );
});
