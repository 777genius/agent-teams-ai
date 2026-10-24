import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { ProviderManagementCoordinator } from '../dist/composition/ProviderManagementCoordinator.js';
import type { CodexManagementProfile } from '../dist/management/profile.js';

const tick = () => new Promise<void>((done) => setTimeout(done, 10));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

for (const scenario of [
  'success',
  'options-success',
  'wrong-effort',
  'wrong-tier',
  'wrong-home',
  'wrong-model',
  'model-failed',
  'reply-lost',
] as const)
  test(`captured Codex finite preflight ${scenario} retains original inference identity and exact cleanup`, async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-codex-model-probe-')));
    const home = join(root, 'home'),
      config = join(root, 'config'),
      cwd = join(root, 'workspace');
    for (const path of [home, config, cwd]) mkdirSync(path);
    const executable = join(root, 'TEST-codex');
    // Existing synthetic Node peer, never a user CLI/account or project.
    writeFileSync(
      executable,
      `#!/bin/sh\nexec ${quote(realpathSync(process.execPath))} ${quote(resolve(import.meta.dirname, 'fixtures/codex-metadata-peer.ts'))} "$@"\n`
    );
    chmodSync(executable, 0o700);
    const profile: CodexManagementProfile = {
      provider: 'codex',
      protocolRevision: '0.162.0',
      profileId: 'TEST-profile',
      configRevision: 'TEST-config',
      accountBinding: 'TEST-account',
      cwd,
      timeoutMs: 2000,
      modelProbeTimeoutMs: 2000,
      modelProvider: 'TEST-local',
      ...(['options-success', 'wrong-effort', 'wrong-tier'].includes(scenario)
        ? { reasoningEffort: 'minimal', fastMode: true }
        : {}),
      executable: {
        path: executable,
        sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
      },
      environment: {
        HOME: home,
        CODEX_HOME: config,
        PATH: '/TEST/no-ambient-bin',
        TEST_PROBE: scenario,
        ...(scenario === 'wrong-home' ? { TEST_WRONG_NAMESPACE: '1' } : {}),
      },
    };
    const owner = new ProviderManagementCoordinator([], () => {}, root);
    t.after(async () => {
      await owner.close();
      rmSync(root, { recursive: true, force: true });
    });
    owner.admitTeamProbeProfile(profile);
    const identity = {
      commandId: 'TEST-original-check',
      profileId: profile.profileId,
      configRevision: profile.configRevision,
    };
    const input = {
      ...identity,
      providerId: 'codex',
      modelId: 'TEST-selected-model',
      ...(profile.reasoningEffort === undefined ? {} : { effort: 'minimal' as const }),
    };
    const expectedOk = scenario === 'success' || scenario === 'options-success';
    assert.equal(owner.probes.readCurrent(identity), null);
    owner.probes.start(input);
    const deadline = Date.now() + 5000;
    while (owner.probes.read(identity)?.phase === 'running' && Date.now() < deadline) await tick();
    const result = owner.probes.readCurrent(identity)!;
    assert.notEqual(result.phase, 'running');
    assert.equal(result.ok, expectedOk);
    assert.equal(
      result.phase,
      scenario === 'reply-lost' || scenario === 'wrong-home' ? 'held' : 'completed'
    );
    owner.probes.start(input);
    const wire = readFileSync(join(home, 'TEST-wire.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
    assert.equal(wire.filter((frame) => frame.method === 'initialize').length, 1);
    assert.equal(
      wire.filter((frame) => frame.method === 'thread/start').length,
      scenario === 'wrong-home' ? 0 : 1
    );
    const turns = wire.filter((frame) => frame.method === 'turn/start');
    assert.equal(
      turns.length,
      ['wrong-model', 'wrong-home', 'wrong-effort', 'wrong-tier'].includes(scenario) ? 0 : 1
    );
    const thread = wire.find((frame) => frame.method === 'thread/start');
    if (thread)
      assert.deepEqual(thread.params, {
        cwd,
        model: 'TEST-selected-model',
        modelProvider: 'TEST-local',
        approvalPolicy: 'never',
        sandbox: 'read-only',
      });
    if (profile.reasoningEffort) {
      const args = JSON.parse(readFileSync(join(home, 'TEST-args.json'), 'utf8')) as string[];
      assert.ok(args.includes('model_reasoning_effort=\"minimal\"'));
      assert.ok(args.includes('service_tier=\"fast\"'));
      assert.ok(args.includes('features.fast_mode=true'));
      if (turns.length) assert.equal(turns[0]!.params?.effort, 'minimal');
    }
    assert.equal(
      wire.some((frame) => frame.method.startsWith('account/')),
      false
    );
    assert.equal((await owner.probes.cancel(identity)).ok, expectedOk);
  });
