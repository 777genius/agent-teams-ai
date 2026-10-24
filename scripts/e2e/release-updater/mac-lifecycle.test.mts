import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { digest } from '../../ci/release/contract.ts';
import { waitFor } from './cdp.mts';
import { MacCommands } from './mac-loopback.mts';
import { oldMacStopApps, retireOldMacShipIt } from './mac-old-native.mts';

void test('command START survives a still-running command without exposing arguments', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-mac-command-progress-'));
  try {
    const commands = new MacCommands(root);
    let completed = false;
    const result = commands
      .run('blocked-fixture', process.execPath, [
        '-e',
        'setTimeout(()=>{},500)',
        'private-argument',
      ])
      .then((value) => {
        completed = true;
        return value;
      });
    const start = await waitFor(
      async () => (await readdir(root)).find((name) => name.endsWith('-start.json')) ?? null,
      'independent command START artifact',
      2000
    );
    assert.equal(completed, false);
    const bytes = await readFile(path.join(root, start), 'utf8');
    const progress = JSON.parse(bytes) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(progress).sort((left, right) => left.localeCompare(right, 'en')),
      ['executable', 'label', 'startedAt', 'state', 'timeout']
    );
    assert.equal(progress.state, 'START');
    assert.equal(progress.executable, process.execPath);
    assert.equal(bytes.includes('private-argument'), false);
    assert.equal((await stat(path.join(root, start))).mode & 0o777, 0o600);
    assert.equal((await result).exitCode, 0);
    const end = JSON.parse(
      await readFile(path.join(root, start.replace('-start.', '-complete.')), 'utf8')
    ) as Record<string, unknown>;
    assert.deepEqual(end, { ...progress, state: 'COMPLETE' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A foreign job or an unregistered launch must fail before launchd removal or process signals.
void test('ShipIt retirement preserves ownership gates and removal/absence precede app stop', async (context) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const savedEnvironment = { ...process.env };
  assert(platform);
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  try {
    for (const scenario of [
      'valid',
      'absent',
      'foreign-label',
      'foreign-program',
      'foreign-state',
      'incomplete-owner',
      'removal-still-present',
    ]) {
      await context.test(scenario, async () => {
        const root = await realpath(
          await mkdtemp(path.join(os.tmpdir(), 'TEST-mac-old-retirement-'))
        );
        try {
          const app = path.join(root, 'TEST-Applications', 'Agent Teams AI.app');
          const home = path.join(root, 'home');
          const label = 'com.agent-teams.app.ShipIt';
          const program = path.join(
            app,
            'Contents',
            'Frameworks',
            'Squirrel.framework',
            'Resources',
            'ShipIt'
          );
          const cache = path.join(home, 'Library', 'Caches', label);
          await mkdir(path.dirname(program), { recursive: true });
          await mkdir(cache, { recursive: true });
          await writeFile(program, 'TEST owned program');
          const reader = path.join(root, 'TEST-launchd-reader');
          await writeFile(reader, 'TEST reader never executed');
          const state = path.join(cache, 'ShipItState.plist');
          await writeFile(
            state,
            JSON.stringify({
              targetBundleURL: pathToFileURL(app).href,
              updateBundleURL: pathToFileURL(path.join(cache, 'consumed-update')).href,
              launchAfterInstallation: true,
            })
          );
          Object.assign(process.env, {
            HOME: home,
            RUNNER_TEMP: path.dirname(root),
            GITHUB_ACTIONS: 'true',
            GITHUB_REPOSITORY: '777genius/agent-teams-ai',
            GITHUB_WORKFLOW_REF:
              '777genius/agent-teams-ai/.github/workflows/updater-mac-old-updater.yml@TEST',
            GITHUB_SHA: 'a'.repeat(40),
          });
          const uid = process.getuid?.();
          assert(uid !== undefined);
          await writeFile(
            path.join(root, 'pf-owned.json'),
            JSON.stringify({
              toolingSha: process.env.GITHUB_SHA,
              uid,
              app,
              home,
              earliest: Date.now(),
              native: { job: reader, jobSha256: digest(await readFile(reader)) },
              attempts:
                scenario === 'incomplete-owner'
                  ? [{ attempted: true }]
                  : [
                      {
                        attempted: true,
                        pid: 123,
                        owner: {
                          pid: 123,
                          uid,
                          group: 123,
                          start: new Date().toISOString(),
                          command: path.join(app, 'Contents', 'MacOS', 'Agent Teams AI'),
                        },
                      },
                    ],
              baselineDisabled: true,
              shipItAbsentBefore: true,
              restored: false,
            })
          );
          let present = scenario !== 'absent';
          const effects: string[] = [];
          const jobReadback = () =>
            JSON.stringify({
              present,
              job: {
                Label:
                  scenario === 'foreign-label' ? 'foreign.ShipIt' : 'com.agent-teams.app.ShipIt',
                ProgramArguments: [
                  scenario === 'foreign-program' ? '/foreign/ShipIt' : program,
                  'com.agent-teams.app.ShipIt',
                  scenario === 'foreign-state' ? '/foreign/state' : state,
                ],
                StandardOutPath: path.join(cache, 'ShipIt_stdout.log'),
                StandardErrorPath: path.join(cache, 'ShipIt_stderr.log'),
              },
            });
          class FixtureCommands extends MacCommands {
            override run(label: string, binary: string, args: string[]) {
              let stdout = '';
              let stderr = '';
              let exitCode = 0;
              if (label === 'shipit-job-dictionary') {
                effects.push(present ? 'read-present' : 'read-absent');
                stdout = jobReadback();
              } else if (label === 'shipit-launchd-domain') {
                exitCode = present && !args[1]?.startsWith('system/') ? 0 : 113;
                stderr = exitCode ? 'Could not find service' : '';
              } else if (label === 'remove-owned-shipit-job') {
                effects.push('remove');
                assert.equal(binary, reader);
                assert.deepEqual(args, ['--remove-job']);
                if (scenario !== 'removal-still-present') present = false;
              } else {
                assert.equal(label, 'process-identities');
                effects.push('stop-scan');
                stdout = `${process.pid} ${uid} ${process.pid} Wed Oct 7 01:00:00 2026 ${process.execPath}`;
              }
              return Promise.resolve({
                command: binary,
                exitCode,
                stdout,
                stderr,
                outputSha256: digest(stdout),
                logFile: 'TEST-fixture.log',
              });
            }
          }
          const commands = new FixtureCommands(root);
          if (scenario === 'valid' || scenario === 'absent') {
            await retireOldMacShipIt(commands);
            await oldMacStopApps(commands);
            assert.equal(effects.includes('remove'), scenario === 'valid');
            assert(effects.indexOf('read-absent') < effects.indexOf('stop-scan'));
            if (scenario === 'valid')
              assert(effects.indexOf('remove') < effects.indexOf('read-absent'));
          } else {
            await assert.rejects(retireOldMacShipIt(commands));
            assert.equal(effects.includes('stop-scan'), false);
            assert.equal(effects.includes('remove'), scenario === 'removal-still-present');
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  } finally {
    Object.defineProperty(process, 'platform', platform);
    process.env = savedEnvironment;
  }
});
