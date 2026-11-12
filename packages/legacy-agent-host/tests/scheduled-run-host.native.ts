import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyNativeProviderArtifact } from './fixtures/native-provider-artifact.ts';
import { scheduledRunSnapshotSchema } from '../dist/composition/scheduledRunContracts.js';
import { fileHash, startHost, treeHash } from './fixtures/native-host.ts';
import { scheduledNativePrompt, startScheduledNativeModel } from './fixtures/native-scheduled-model.ts';
import type { ScheduledNativeMode } from './fixtures/native-scheduled-model.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { ScheduledRunInput } from '../dist/composition/scheduledRunContracts.js';

const pins = {
  claude: '86cb722ab68348877dba7971e4d0c659919e05e6228c05e006e83da320e656ef',
  codex: '50ed828f357c655a3c82054d346cab8434f24901f14ec19b8267571bdd008b38',
};
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
};
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 75_000;
  while (!await check()) { assert.ok(Date.now() < deadline, label); await delay(50); }
}
async function transcriptFiles(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? transcriptFiles(join(path, entry.name))
      : Promise.resolve(entry.name.endsWith('.jsonl') ? [join(path, entry.name)] : [])))).flat();
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

for (const provider of ['claude', 'codex'] as const) test(
  `actual ${provider} finite Host schedule: tool, replay, cold outcome, cancellation and native limits`,
  { timeout: 300_000 }, async t => {
    assert.equal(process.env.LEGACY_SCHEDULE_NATIVE_GO, '1');
    assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.equal(process.version, 'v24.21.0');
    const repo = resolve(import.meta.dirname, '../../..'), node = await realpath(process.execPath);
    const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(sourceHead, process.env.LEGACY_SCHEDULE_SOURCE_HEAD);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '');
    const sourceBefore = await treeHash(join(repo, 'packages/legacy-agent-host/src'), '.ts');
    const distBefore = await treeHash(join(repo, 'packages/legacy-agent-host/dist'), '.js');
    const harnessBefore = await treeHash(join(repo, 'packages/legacy-agent-host/tests'), '.ts');
    const artifact = await realpath(process.env.LEGACY_NATIVE_PROVIDER_ARTIFACT!);
    assert.equal(await fileHash(artifact), process.env.LEGACY_NATIVE_PROVIDER_SHA256);
    const hostPackage = object(JSON.parse(await readFile(join(repo, 'packages/legacy-agent-host/package.json'), 'utf8')));
    const dependency = object(hostPackage.dependencies)['@agent-teams/provider-implementations'];
    assert.ok(typeof dependency === 'string' && dependency.startsWith('file:../../vendor/provider-migration/'));
    assert.equal(artifact, await realpath(resolve(repo, 'packages/legacy-agent-host', dependency.slice(5))));
    await verifyNativeProviderArtifact(repo, { path: relative(repo, artifact), sha256: await fileHash(artifact) });
    const output = await realpath(process.env.LEGACY_SCHEDULE_NATIVE_EVIDENCE!);
    assert.match(output, /\/TEST-[^/]+/);
    const root = await realpath(await mkdtemp(join(tmpdir(), `TEST-scheduled-native-${provider}-`)));
    for (const name of ['home', 'config', 'tmp', 'workspace', 'store', 'data', 'cache'])
      await mkdir(join(root, name), { mode: 0o700 });
    const supplied = await realpath(process.env[provider === 'claude' ? 'LEGACY_SCHEDULE_CLAUDE' : 'LEGACY_SCHEDULE_CODEX']!);
    assert.equal(await fileHash(supplied), pins[provider]);
    const binary = join(root, provider);
    await copyFile(supplied, binary, constants.COPYFILE_EXCL); await chmod(binary, 0o700);
    assert.equal(await fileHash(binary), pins[provider]);
    const model = await startScheduledNativeModel(provider);
    let finalOwnsCleanup = false;
    t.after(async () => { if (!finalOwnsCleanup) await model.close(); });
    const environment = { HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
      XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
      PATH: `${dirname(node)}:/usr/bin:/bin`, SHELL: '/bin/sh',
      ...(provider === 'claude' ? { CLAUDE_CONFIG_DIR: join(root, 'config'),
        ANTHROPIC_API_KEY: 'TEST-LOCALHOST-ONLY', ANTHROPIC_BASE_URL: model.url,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', NO_COLOR: '1' }
        : { CODEX_HOME: join(root, 'config'), TEST_CODEX_FIXTURE_KEY: 'TEST-LOCALHOST-ONLY' }) };
    if (provider === 'codex') await writeFile(join(root, 'config/config.toml'), `model = "mock-model"
model_provider = "TEST_fixture"
approval_policy = "never"
sandbox_mode = "danger-full-access"
web_search = "disabled"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"
project_doc_max_bytes = 0
[analytics]
enabled = false
[otel]
exporter = "none"
metrics_exporter = "none"
[features]
code_mode = false
apps = false
plugins = false
remote_models = false
shell_snapshot = false
skip_host_skill_discovery = true
enable_request_compression = false
multi_agent = false
[model_providers.TEST_fixture]
name = "TEST local fixture"
base_url = ${JSON.stringify(model.url + '/v1')}
env_key = "TEST_CODEX_FIXTURE_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`, { mode: 0o600 });
    const team = { backendId: 'TEST-scheduled-backend', teamId: 'TEST-scheduled-team', teamName: 'test-scheduled-native' };
    const scope = { projectId: 'TEST-scheduled-project', workspaceId: 'TEST-scheduled-project',
      teamId: team.teamId, runId: 'TEST-team-original', memberId: 'human', generation: '1' };
    const common = { teamId: team.teamId, memberId: 'lead', principalId: 'lead-principal',
      sessionId: 'TEST-team-original-session', generation: 1, configRevision: 'TEST-native-config',
      cwd: join(root, 'workspace'), model: provider === 'claude' ? 'claude-sonnet-4-6' : 'mock-model',
      accountBinding: 'TEST-account', environment, executable: { path: binary, sha256: pins[provider] },
      limits: { queuedInputs: 1, inputBytes: 65536, outputBytes: 1_000_000,
        outputEvents: 1000, pendingInteractions: 1, timeoutMs: 45_000 } };
    const profile: TeamHostProfile = { schemaVersion: 1, principalId: 'human',
      owner: { ownerId: team.backendId, revision: '1', storageRoot: join(root, 'store'), profileId: 'TEST-schedule-profile',
        protocolVersion: 1, buildId: 'TEST-schedule-native', nodeSha256: await fileHash(node),
        hostEntrySha256: await fileHash(join(repo, 'packages/legacy-agent-host/dist/cli.js')) },
      teams: [{ binding: team, scope,
        savedSettings: { cwd: common.cwd, providerId: provider === 'claude' ? 'anthropic' : 'codex', prompt: 'TEST saved team prompt must not run' },
        members: [{ memberId: 'lead', name: 'team-lead', role: 'lead',
          delivery: { ...team, runId: scope.runId, memberId: 'lead', generation: '1' } }],
        grants: [{ principalId: 'human', memberName: 'user', permissions: ['read', 'admin', 'task.write', 'message.write'] },
          { principalId: 'lead-principal', memberName: 'team-lead', permissions: ['read', 'task.write', 'message.write'] }] }],
      runtime: { members: [provider === 'claude'
        ? { ...common, provider, nativeTools: ['Bash'], autoAllowedTools: ['Bash'], nativeOptions: { settingSources: [] } }
        : { ...common, provider, protocolRevision: '0.162.0', nativeOptions: {
          approvalPolicy: 'never', sandbox: 'danger-full-access', modelProvider: 'TEST_fixture', reasoningEffort: 'low' } }] } };
    const profilePath = join(root, 'host-profile.json');
    await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
    const profileHash = await fileHash(profilePath);
    const open = () => startHost({ node, root, entry: join(repo, 'packages/legacy-agent-host/dist/cli.js'),
      profile: profilePath, profileHash });
    let host = open(), passed = false, cleanup = false;
    finalOwnsCleanup = true;
    const binding = { schemaVersion: 1, handleId: 'TEST-schedule-handle', owner: profile.owner, scope };
    const receipts: unknown[] = [];
    const rpc = (method: string, payload: unknown, commandId = 'TEST-read') => host.rpc(method, { commandId, binding, payload });
    try {
      await host.rpc('host.handshake', { protocolVersion: 1 });
      const roster = await rpc('team.roster.read', {}); assert.equal(roster.ok, true);
      const request = (mode: ScheduledNativeMode): ScheduledRunInput => ({
        runId: `TEST-${provider}-${mode}`, scheduleId: 'TEST-original-schedule', expectedRosterRevision: String(object(roster.value).revision),
        config: { cwd: common.cwd, providerId: provider === 'claude' ? 'anthropic' : 'codex',
          prompt: scheduledNativePrompt(mode), model: common.model, effort: 'low', resolvedFastMode: false, skipPermissions: true },
        ...(provider === 'claude' ? { maxTurns: mode === 'turn-limit' ? 1 : 8,
          ...(mode === 'budget' ? { maxBudgetUsd: 0.000001 } : {}) } : {}) });
      const read = async (input: ScheduledRunInput) => {
        const result = await rpc('schedule.run.read', { runId: input.runId, scheduleId: input.scheduleId });
        assert.equal(result.ok, true); return scheduledRunSnapshotSchema.parse(result.value);
      };
      const finish = async (input: ScheduledRunInput) => {
        await until(async () => {
          assert.deepEqual(model.failures, []);
          const value = await read(input); assert.notEqual(value.phase, 'held', JSON.stringify(value));
          return value.phase === 'completed' || value.phase === 'interrupted';
        }, 'original native schedule settles');
        const value = await read(input); assert.equal(value.cleanup, 'confirmed'); receipts.push(value); return value;
      };
      const first = request('success');
      assert.equal((await rpc('schedule.run.start', first, first.runId)).ok, true);
      const completed = await finish(first);
      assert.equal(completed.result?.exitCode, 0); assert.match(completed.result!.stdout, /TEST_SCHEDULE_DONE/);
      assert.equal(await readFile(join(common.cwd, 'schedule-success.txt'), 'utf8'), 'TEST_NATIVE_TOOL\n');
      assert.equal(model.counts.get('success'), 2);
      assert.equal((await rpc('schedule.run.start', first, first.runId)).ok, true);
      assert.equal(model.counts.get('success'), 2, 'same intent only reads its receipt');
      await host.close(); host = open(); await host.rpc('host.handshake', { protocolVersion: 1 });
      const cold = await read(first); assert.equal(cold.result?.exitCode, 0); assert.equal(cold.cleanup, 'confirmed');
      assert.equal((await rpc('schedule.run.start', first, first.runId)).ok, true);
      assert.equal(model.counts.get('success'), 2);
      if (provider === 'claude') for (const mode of ['turn-limit', 'budget'] as const) {
        const limited = request(mode); assert.equal((await rpc('schedule.run.start', limited, limited.runId)).ok, true);
        const result = await finish(limited); assert.equal(result.phase, 'completed'); assert.equal(result.result?.exitCode, 1);
        assert.ok((model.counts.get(mode) ?? 0) >= 1 && model.counts.get(mode)! <= 2, 'actual native limit ends the scripted loop');
      } else {
        const refused = { ...request('turn-limit'), maxTurns: 1 };
        assert.equal((await rpc('schedule.run.start', refused, refused.runId)).ok, false);
        assert.equal(model.counts.has('turn-limit'), false, 'unsupported limit refused before model allocation');
      }
      const cancelled = request('cancel');
      assert.equal((await rpc('schedule.run.start', cancelled, cancelled.runId)).ok, true);
      await until(() => model.counts.get('cancel') === 1, 'native request is in flight before cancel');
      assert.equal((await rpc('schedule.run.cancel', { runId: cancelled.runId, scheduleId: cancelled.scheduleId })).ok, true);
      const stopped = await finish(cancelled); assert.notEqual(stopped.result?.exitCode, 0);
      assert.equal(model.counts.get('cancel'), 1);
      assert.deepEqual((await rpc('team.tasks.list', {})).value, [], 'finite execution creates no hidden Team task');
      assert.deepEqual(await transcriptFiles(join(root, 'config', provider === 'claude' ? 'projects' : 'sessions')), [],
        'native ephemeral session does not write a persisted conversation transcript');
      assert.deepEqual(model.failures, []); passed = true;
    } finally {
      try {
        const results = await Promise.allSettled([host.close(), model.close()]);
        cleanup = results.every(result => result.status === 'fulfilled');
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      }
      finally {
        const frozen = await treeHash(join(repo, 'packages/legacy-agent-host/src'), '.ts') === sourceBefore &&
          await treeHash(join(repo, 'packages/legacy-agent-host/dist'), '.js') === distBefore &&
          await treeHash(join(repo, 'packages/legacy-agent-host/tests'), '.ts') === harnessBefore &&
          await fileHash(artifact) === process.env.LEGACY_NATIVE_PROVIDER_SHA256 &&
          await fileHash(profilePath) === profileHash && await fileHash(binary) === pins[provider];
        await writeFile(join(output, `${provider}-scheduled-native.json`), JSON.stringify({
          kind: 'TEST_NATIVE_SCHEDULED_HOST', status: passed && cleanup && frozen ? 'PASS' : 'INCOMPLETE',
          provider, nativeSha256: pins[provider], providerSha256: await fileHash(artifact), nodeVersion: process.version,
          sourceHead, hostSourceSha256: sourceBefore, hostDistSha256: distBefore,
          harnessSha256: harnessBefore, cleanup, frozen,
          modelRequests: model.requests, modelFailures: model.failures, receipts, root,
          desktopQualified: false, vendorAuthQualified: false,
        }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        assert.equal(frozen, true);
      }
    }
  });
