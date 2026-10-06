import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { MacCommands, containMacNetwork } from './mac-loopback.mts';
import { containOldMacNetwork } from './mac-old-native.mts';
import { serializeMacPfBaseline } from './mac-pf-baseline.mts';

import type { CommandResult } from './mac-loopback.mts';

// This command boundary records intent and executes no OS commands or network calls.
class UnparseableBaselineCommands extends MacCommands {
  readonly calls: { label: string; args: string[] }[] = [];
  override async run(label: string, _binary: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ label, args });
    const rejected = label === 'pf-parse-active-baseline';
    return {
      command: 'test-only command boundary',
      exitCode: rejected ? 1 : 0,
      stdout: label.endsWith('status') ? 'Status: Disabled\n' : 'captured active dump\n',
      stderr: rejected ? 'baseline cannot parse' : '',
      outputSha256: 'a'.repeat(64),
      logFile: `${label}.log`,
    };
  }
}

void test('both native containment paths reject an unparseable restore baseline before PF mutation', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
  const saved = Object.fromEntries(
    ['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_WORKFLOW_REF'].map((name) => [
      name,
      process.env[name],
    ])
  );
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-pf-baseline-'));
  try {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => 501 });
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_REPOSITORY = '777genius/agent-teams-ai';
    for (const workflow of ['updater-mac-updater', 'updater-mac-old-updater']) {
      process.env.GITHUB_WORKFLOW_REF = `777genius/agent-teams-ai/.github/workflows/${workflow}.yml@main`;
      const output = await mkdtemp(path.join(root, 'TEST-command-output-'));
      const commands = new UnparseableBaselineCommands(output);
      const app = path.join(root, 'TEST.app');
      await assert.rejects(
        workflow === 'updater-mac-updater'
          ? containMacNetwork(commands, app)
          : containOldMacNetwork(commands, app, root, {
              job: path.join(root, 'TEST-job-reader'),
              aqua: path.join(root, 'TEST-aqua-reader'),
              jobSha256: 'a'.repeat(64),
              aquaSha256: 'b'.repeat(64),
            }),
        /baseline cannot parse/u
      );
      assert.deepEqual(
        commands.calls.map(({ label }) => label),
        ['pf-baseline-status', 'pf-baseline-rules', 'pf-baseline-nat', 'pf-parse-active-baseline']
      );
      assert.deepEqual(commands.calls.at(-1)?.args, [
        '-n',
        '/sbin/pfctl',
        '-n',
        '-f',
        path.join(output, 'pf-baseline-active.conf'),
      ]);
      assert.equal(
        await readFile(path.join(output, 'pf-baseline-active.conf'), 'utf8'),
        'set require-order no\ncaptured active dump\n\ncaptured active dump\n'
      );
    }
  } finally {
    assert(platform);
    Object.defineProperty(process, 'platform', platform);
    if (getuid) Object.defineProperty(process, 'getuid', getuid);
    else Reflect.deleteProperty(process, 'getuid');
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

void test('native macOS 15 anchor dumps retain normalization, NAT and filter bytes in the restore config', () => {
  // Actual x64 runner dumps from read-only workflow 37494162902. Concatenating
  // these without the parser option fails on the scrub-anchor after NAT rules.
  const nat = 'nat-anchor "com.apple/*" all\nrdr-anchor "com.apple/*" all\n';
  const rules =
    'scrub-anchor "com.apple/*" all fragment reassemble\nanchor "com.apple/*" all\n';
  const baseline = serializeMacPfBaseline(nat, rules);
  assert.equal(baseline.split('\n')[0], 'set require-order no');
  assert.equal(baseline.slice(baseline.indexOf('\n') + 1), `${nat}\n${rules}`);
});

void test('serialization preserves rule priority within each dump and supports an empty active baseline', () => {
  const nat = 'nat on en0 from 192.0.2.0/24 to any -> 198.51.100.1\n';
  const rules = 'block quick from 203.0.113.0/24 to any\npass from any to any\n';
  const baseline = serializeMacPfBaseline(nat, rules);
  assert(baseline.includes(nat));
  assert(baseline.endsWith(rules));
  assert.equal(serializeMacPfBaseline('', ''), 'set require-order no\n\n');
});
