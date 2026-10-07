import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { digest } from '../../ci/release/contract.ts';
import { waitFor } from './cdp.mts';
import { MacCommands } from './mac-loopback.mts';
import { oldMacStopApps, paintedMacDesktop } from './mac-old-native.mts';

import type { TestContext } from 'node:test';
import type { MacIdentity } from './mac-old-native.mts';

async function fixture(context: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-mac-old-stop-paint-')));
  const home = path.join(root, 'home');
  const app = path.join(root, 'TEST-Applications', 'Agent Teams AI.app');
  await mkdir(home);
  await mkdir(app, { recursive: true });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const environment = { ...process.env };
  assert(platform);
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.assign(process.env, {
    HOME: home,
    RUNNER_TEMP: path.dirname(root),
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: '777genius/agent-teams-ai',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_REF:
      '777genius/agent-teams-ai/.github/workflows/updater-mac-old-updater.yml@TEST',
  });
  context.after(async () => {
    Object.defineProperty(process, 'platform', platform);
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    await rm(root, { recursive: true, force: true });
  });
  const owner: MacIdentity = {
    pid: 10687,
    uid: process.getuid?.() ?? 0,
    group: 10687,
    start: 'Wed Oct 7 08:39:03 2026',
    command: `${app}/Contents/MacOS/Agent Teams AI`,
  };
  const sibling = {
    ...owner,
    pid: 11680,
    start: 'Wed Oct 7 08:39:44 2026',
    command: `${app}/Contents/Resources/runtime/claude-multimodel`,
  };
  const reader = path.join(root, 'TEST-launchd-reader');
  await writeFile(reader, 'TEST reader never executed');
  await writeFile(
    path.join(root, 'pf-owned.json'),
    JSON.stringify({
      toolingSha: process.env.GITHUB_SHA,
      uid: owner.uid,
      app,
      home,
      earliest: 0,
      native: { job: reader, jobSha256: digest(await readFile(reader)) },
      attempts: [{ attempted: true, pid: owner.pid, owner }],
      baselineDisabled: true,
      shipItAbsentBefore: true,
      restored: false,
    })
  );
  const signals: [number, string][] = [];
  context.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
    assert(signal === 'SIGTERM' || signal === 'SIGKILL');
    signals.push([pid, signal]);
    return true;
  });
  const row = (entry: MacIdentity) =>
    `${entry.pid} ${entry.uid} ${entry.group} ${entry.start} ${entry.command}`;
  let scan = () => [owner];
  let image = () => ({
    width: 1136,
    height: 793,
    distinctColors: 32,
    meanRgb: 180,
    text: 'Providers & plans Tasks',
  });
  let windowPid = owner.pid;
  let reads = 0;
  class Commands extends MacCommands {
    override async run(label: string, binary: string, args: string[]) {
      let stdout = '';
      if (label === 'process-identities') {
        assert.equal(binary, '/bin/ps');
        stdout = [
          { ...owner, pid: process.pid, group: process.pid, command: process.execPath },
          ...scan(),
        ]
          .map(row)
          .join('\n');
      } else if (label === 'aqua-window-owner') {
        stdout = JSON.stringify([
          {
            kCGWindowNumber: 26,
            kCGWindowOwnerPID: windowPid,
            kCGWindowBounds: { Width: 1136, Height: 793 },
          },
        ]);
      } else if (label === 'capture-native-aqua') {
        assert(args[3]);
        await writeFile(args[3], Buffer.alloc(1201));
      } else {
        assert.equal(label, 'read-painted-aqua-ocr');
        reads++;
        stdout = JSON.stringify(image());
      }
      return {
        command: binary,
        exitCode: 0,
        stdout,
        stderr: '',
        outputSha256: digest(stdout),
        logFile: 'TEST-native-fixture.log',
      };
    }
  }
  return {
    commands: new Commands(root),
    owner,
    sibling,
    signals,
    reader,
    setScan: (value: typeof scan) => {
      scan = value;
    },
    setImage: (value: typeof image) => {
      image = value;
    },
    setWindow: (pid: number) => {
      windowPid = pid;
    },
    imageReads: () => reads,
  };
}

// Old code aborts at the sibling identity assertion instead of waiting without another signal.
void test('post-TERM captured defunct and argv fallback siblings receive no signal before absence', async (context) => {
  for (const command of ['<defunct>', '(claude-multimode)']) {
    await context.test(command, async (child) => {
      const f = await fixture(child);
      let reads = 0;
      f.setScan(() => {
        if (!f.signals.length) return [f.owner, f.sibling];
        return reads++ < 2 ? [{ ...f.sibling, command }] : [];
      });
      const stopped = await oldMacStopApps(f.commands);
      assert.equal(stopped.stopped, true);
      assert.deepEqual(stopped.before, [f.owner, f.sibling]);
      assert.deepEqual(f.signals, [[f.owner.pid, 'SIGTERM']]);
      assert(reads >= 3, 'uncertain PID must be read through actual absence');
    });
  }
});

void test('a persistent uncertain PID blocks cleanup without another signal', async (context) => {
  const f = await fixture(context);
  f.setScan(() =>
    !f.signals.length ? [f.owner, f.sibling] : [{ ...f.sibling, command: '<defunct>' }]
  );
  await assert.rejects(oldMacStopApps(f.commands), /timed out: post-TERM uncertain PID exited/);
  assert.deepEqual(f.signals, [[f.owner.pid, 'SIGTERM']]);
});

void test('foreign and reused identities still reject before a signal', async (context) => {
  for (const afterTerm of [false, true]) {
    for (const changed of ['command', 'start'] as const) {
      await context.test(`${changed}, prior TERM ${afterTerm}`, async (child) => {
        const f = await fixture(child);
        let reads = 0;
        f.setScan(() => {
          if (reads++ === 0 || (afterTerm && !f.signals.length)) return [f.owner, f.sibling];
          const target = afterTerm ? f.sibling : f.owner;
          return [
            {
              ...target,
              [changed]: changed === 'command' ? '/foreign/executable' : 'Wed Oct 7 08:40:44 2026',
            },
          ];
        });
        await assert.rejects(oldMacStopApps(f.commands));
        assert.deepEqual(f.signals, afterTerm ? [[f.owner.pid, 'SIGTERM']] : []);
      });
    }
  }
});

void test('fresh foreign and reused identities reject immediately before forced KILL', async (context) => {
  for (const changed of ['command', 'start'] as const) {
    await context.test(changed, async (child) => {
      const f = await fixture(child);
      f.setScan(() =>
        f.signals.length < 2
          ? [f.owner, f.sibling]
          : [
              {
                ...f.owner,
                [changed]:
                  changed === 'command' ? '/foreign/executable' : 'Wed Oct 7 08:40:44 2026',
              },
            ]
      );
      await assert.rejects(oldMacStopApps(f.commands));
      assert.deepEqual(f.signals, [
        [f.owner.pid, 'SIGTERM'],
        [f.sibling.pid, 'SIGTERM'],
      ]);
    });
  }
});

// Recorded ARM first frame has 28 colors and empty OCR. It must retry, never pass.
void test('captured first unpainted frame remains pending until the existing paint contract passes', async (context) => {
  const f = await fixture(context);
  let calls = 0;
  f.setImage(() =>
    calls++ === 0
      ? { width: 1136, height: 793, distinctColors: 28, meanRgb: 19, text: '' }
      : {
          width: 300,
          height: 200,
          distinctColors: 32,
          meanRgb: 180,
          text: 'Providers & plans Tasks',
        }
  );
  const painted = await waitFor(
    () => paintedMacDesktop(f.commands, f.reader, f.owner, 'TEST-frame', true),
    'paint fixture',
    2000
  );
  assert.equal(f.imageReads(), 2);
  assert.equal(painted.owner.pid, f.owner.pid);
  assert.equal(painted.pixels.distinctColors, 32);
  assert.deepEqual(f.signals, []);
});

void test('blank frames time out and foreign window ownership is rejected', async (context) => {
  const f = await fixture(context);
  f.setImage(() => ({ width: 1136, height: 793, distinctColors: 28, meanRgb: 19, text: '' }));
  await assert.rejects(
    waitFor(
      () => paintedMacDesktop(f.commands, f.reader, f.owner, 'TEST-blank', false),
      'blank fixture',
      250
    ),
    /timed out/
  );
  assert(f.imageReads() > 1);
  f.setWindow(f.owner.pid + 1);
  await assert.rejects(paintedMacDesktop(f.commands, f.reader, f.owner, 'TEST-foreign', false));
  assert.deepEqual(f.signals, []);
});

// T80 new main 17919 was outside the initial stop snapshot and survived its 5s wait.
void test('one additional owned main receives TERM and binds its group before actual absence', async (context) => {
  const f = await fixture(context);
  const additional = { ...f.owner, pid: 17919, group: 17919, start: 'Wed Oct 7 12:27:46 2026' };
  let afterTerm = 0;
  f.setScan(() => {
    if (!f.signals.length) return [f.owner];
    if (!f.signals.some(([pid, signal]) => pid === f.owner.pid && signal === 'SIGKILL'))
      return [f.owner, additional];
    if (!f.signals.some(([pid]) => pid === additional.pid))
      return [additional, { ...f.sibling, pid: 17920, group: additional.group }];
    const pending = { ...additional, pid: 17921, uid: 0, command: '(ps)' };
    if (afterTerm++ === 0) return [{ ...additional, command: '(Agent Teams AI)' }, pending];
    return afterTerm === 2 ? [pending] : [];
  });
  const stopped = await oldMacStopApps(f.commands);
  assert.deepEqual(f.signals, [
    [f.owner.pid, 'SIGTERM'],
    [f.owner.pid, 'SIGKILL'],
    [additional.pid, 'SIGTERM'],
  ]);
  assert.deepEqual(stopped.before, [f.owner]);
  assert.deepEqual(stopped.additionalMains, [additional]);
  assert.equal(stopped.stopped, true);
  const receipt = JSON.parse(
    await readFile(path.join(f.commands.output, 'pf-owned.json'), 'utf8')
  ) as { attempts: { pid: number; owner: MacIdentity }[] };
  assert.deepEqual(
    receipt.attempts.find((entry) => entry.pid === additional.pid)?.owner,
    additional
  );
  const files = (await readdir(f.commands.output)).filter((name) =>
    name.startsWith('mac-old-stop-')
  );
  assert.equal(files.length, 1);
  const proofName = files[0];
  assert(proofName);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(f.commands.output, proofName), 'utf8')),
    stopped
  );
  assert(afterTerm >= 3, 'fallback and unknown group members block until actual disappearance');
});

void test('additional foreign or changed main is never signalled', async (context) => {
  for (const scenario of [
    'foreign-uid',
    'foreign-group',
    'predates-install',
    'changed-after-admission',
  ] as const) {
    await context.test(scenario, async (child) => {
      const f = await fixture(child);
      const additional = {
        ...f.owner,
        pid: 17919,
        group: scenario === 'foreign-group' ? 999 : 17919,
        uid: scenario === 'foreign-uid' ? f.owner.uid + 1 : f.owner.uid,
        start:
          scenario === 'predates-install' ? 'Wed Oct 7 12:27:46 1966' : 'Wed Oct 7 12:27:46 2026',
      };
      let reads = 0;
      f.setScan(() => {
        if (reads++ < 2) return [];
        return scenario === 'changed-after-admission' && reads > 3
          ? [{ ...additional, start: 'Wed Oct 7 12:27:47 2026' }]
          : [additional];
      });
      await assert.rejects(oldMacStopApps(f.commands));
      assert.deepEqual(f.signals, []);
    });
  }
});

void test('one additional pass does not signal a further new main', async (context) => {
  const f = await fixture(context);
  const additional = { ...f.owner, pid: 17919, group: 17919, start: 'Wed Oct 7 12:27:46 2026' };
  const later = { ...additional, pid: 18000, group: 18000 };
  let reads = 0;
  f.setScan(() => {
    if (reads++ < 2) return [];
    return f.signals.length ? [later] : [additional];
  });
  await assert.rejects(oldMacStopApps(f.commands), /timed out: TEST Mac applications exited/);
  assert.deepEqual(f.signals, [[additional.pid, 'SIGTERM']]);
});
