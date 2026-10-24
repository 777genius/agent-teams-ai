import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { MacCommands, recordMacLaunch } from './mac-loopback.mts';

// Exercises receipt acceptance through the existing launch registration boundary.
// No native command, app, launchd operation, or PF operation executes.
void test('current PF receipt binds the direct TEST install layout before registering launch', async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-current-pf-receipt-')));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const savedEnvironment = { ...process.env };
  assert(platform);
  const output = path.join(root, 'evidence');
  const installRoot = path.join(root, 'TEST-mac-current-fixture');
  const app = path.join(installRoot, 'Applications', 'Agent Teams AI.app');
  const nested = path.join(installRoot, 'home', 'Applications', 'Agent Teams AI.app');
  const foreign = path.join(
    root,
    'foreign',
    'TEST-mac-current-fixture',
    'Applications',
    'Agent Teams AI.app'
  );
  const wrongName = path.join(installRoot, 'Applications', 'Other.app');
  const alias = path.join(root, 'TEST-mac-current-alias');
  try {
    for (const directory of [output, app, nested, foreign, wrongName])
      await mkdir(directory, { recursive: true });
    await symlink(installRoot, alias);
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    Object.assign(process.env, {
      RUNNER_TEMP: root,
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: '777genius/agent-teams-ai',
      GITHUB_WORKFLOW_REF:
        '777genius/agent-teams-ai/.github/workflows/updater-mac-updater.yml@TEST',
      GITHUB_SHA: 'a'.repeat(40),
    });
    const commands = new MacCommands(output);
    const file = path.join(output, 'pf-owned.json');
    const receipt = {
      baselineDisabled: true,
      toolingSha: process.env.GITHUB_SHA,
      applicationRoot: app,
      launchAttempted: false,
      restored: false,
    };
    await context.test('actual direct layout registers the attempt', async () => {
      await writeFile(file, JSON.stringify(receipt));
      await recordMacLaunch(commands);
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
        ...receipt,
        launchAttempted: true,
      });
      assert.equal(commands.commands.length, 0);
    });
    for (const [name, applicationRoot, toolingSha, expectedError] of [
      ['obsolete nested home layout', nested, receipt.toolingSha, /PF receipt install path/],
      ['foreign runner root', foreign, receipt.toolingSha, /PF receipt install path/],
      ['different application name', wrongName, receipt.toolingSha, /PF receipt install path/],
      [
        'symlink install root',
        path.join(alias, 'Applications', 'Agent Teams AI.app'),
        receipt.toolingSha,
        /PF receipt install path/,
      ],
      ['different job SHA', app, 'b'.repeat(40), /PF receipt must belong/],
    ] as const) {
      await context.test(name, async () => {
        const bytes = JSON.stringify({ ...receipt, applicationRoot, toolingSha });
        await writeFile(file, bytes);
        await assert.rejects(recordMacLaunch(commands), expectedError);
        assert.equal(
          await readFile(file, 'utf8'),
          bytes,
          'Rejected receipt must not register a launch'
        );
        assert.equal(commands.commands.length, 0);
      });
    }
  } finally {
    Object.defineProperty(process, 'platform', platform);
    process.env = savedEnvironment;
    await rm(root, { recursive: true, force: true });
  }
});
