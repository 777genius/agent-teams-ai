import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { CodexManagementHost } from '../../packages/legacy-agent-host/dist/adapters/providers/CodexManagementHost.js';
import { readCodexMcpCatalog } from '../../packages/legacy-agent-host/dist/adapters/providers/readCodexMcpCatalog.js';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { createFilesystemTeamOwner } from '../../packages/legacy-agent-host/dist/adapters/team/createFilesystemTeamOwner.js';
import { acquireProfileWriterLease } from '../../packages/legacy-agent-host/dist/adapters/profile/ProfileWriterLease.js';
import { CONTEXT_MARKER } from '../../packages/legacy-agent-host/tests/fixtures/native-codex-team/model.ts';
import { desktopBackendEnvironment, digest, fileDigest } from './desktop-backend-fixture.ts';
import { record } from './desktop-resume-records.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import type { CodexMemberProfile } from '../../packages/legacy-agent-host/dist/composition/runtimeProfile.js';
import type { CodexManagementProfile } from '../../packages/legacy-agent-host/dist/management/profile.js';

const CODEX_SHA256 = '8238273076041e55beded03ba1d51e034f997b7d100b0642d36daf036620fe57';

/** Private TEST recipe only. The original Launch controls still own preflight and every effect. */
export async function prepareDesktopCodexResumeFixture(
  base: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>,
  options: { executable: string; modelUrl: string }
) {
  const assertCurrent = () => {
    assert.equal(process.env.LEGACY_DESKTOP_BACKEND_GO, '1');
    assert.match(basename(base.root), /^TEST-desktop-backend-/);
  };
  assertCurrent();
  assert.equal(base.uiSeed, undefined, 'Codex settings must be selected before the original canonical seed');
  assert.equal(await realpath(base.root), base.root);
  assert.equal(await fileDigest(base.profilePath), base.pins.profileSha256);
  assert.equal(await fileDigest(base.descriptorPath), base.pins.descriptorSha256);
  assert.equal(await realpath(options.executable), options.executable);
  assert.equal(await fileDigest(options.executable), CODEX_SHA256);
  const url = new URL(options.modelUrl);
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
  assert.ok(url.port); assert.equal(url.origin, options.modelUrl);
  const profile: TeamHostProfile = readTeamHostProfile(base.profilePath, base.pins.profileSha256);
  assert.equal(profile.owner.storageRoot, join(base.root, 'hoststore'));
  assert.equal(profile.runtime?.members.length, 1);
  const original = profile.runtime!.members[0]!;
  assert.equal(original.memberId, 'alice-id');
  assert.equal(original.cwd, join(base.root, 'workspace'));
  const home = join(base.root, 'native-codex/home'), config = join(base.root, 'native-codex/config');
  const tmp = join(base.root, 'native-codex/tmp');
  for (const path of [home, config, tmp]) await mkdir(path, { recursive: true, mode: 0o700 });
  const configBytes = `model_provider = "TEST_fixture"
model_reasoning_effort = "low"
approval_policy = "never"
sandbox_mode = "workspace-write"
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
[shell_environment_policy]
inherit = "none"
set = { HOME = ${JSON.stringify(home)}, TMPDIR = ${JSON.stringify(tmp)}, PATH = "/usr/bin:/bin" }
[model_providers.TEST_fixture]
name = "TEST fixture"
base_url = ${JSON.stringify(options.modelUrl + '/v1')}
env_key = "TEST_CODEX_FIXTURE_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`;
  const configPath = join(config, 'config.toml');
  await writeFile(configPath, configBytes, { mode: 0o600, flag: 'wx' });
  const environment = { HOME: home, CODEX_HOME: config, TMPDIR: tmp,
    PATH: dirname(base.node) + ':/usr/bin:/bin', SHELL: '/bin/sh', TEST_CODEX_FIXTURE_KEY: 'TEST-LOCALHOST-ONLY' };
  const management: CodexManagementProfile = {
    provider: 'codex', protocolRevision: '0.162.0', profileId: 'TEST-codex-resume-management',
    accountBinding: 'TEST-LOCALHOST-ONLY', configRevision: 'TEST-codex-resume-management-config',
    cwd: original.cwd, environment, executable: { path: options.executable, sha256: CODEX_SHA256 },
    modelProvider: 'TEST_fixture', timeoutMs: 15000, modelProbeTimeoutMs: 30000,
  };
  // One finite, custody-confirmed metadata child; no fabricated model/list or business input.
  const catalog = await new CodexManagementHost(management, () => {
    try { assertCurrent(); return true; } catch { return false; }
  }).read(true);
  const selected = catalog.models.find(model => !model.hidden && model.inputModalities.includes('text') &&
    ['low', 'medium'].every(effort => model.supportedReasoningEfforts.includes(effort)));
  assert.ok(selected, 'actual visible Codex catalog has a text model supporting original low→medium controls');
  const finalConfigBytes = `model = ${JSON.stringify(selected.model)}\n` + configBytes;
  assert.equal(await fileDigest(configPath), digest(configBytes));
  await writeFile(configPath, finalConfigBytes, { mode: 0o600 });
  const member: CodexMemberProfile = {
    provider: 'codex', protocolRevision: '0.162.0', teamId: original.teamId, memberId: original.memberId,
    principalId: original.principalId, sessionId: 'TEST-native-codex-resume', generation: original.generation,
    configRevision: 'TEST-native-codex-resume-config', cwd: original.cwd,
    accountBinding: management.accountBinding, model: selected.model, executable: management.executable, environment,
    nativeOptions: { approvalPolicy: 'never', sandbox: 'workspace-write', modelProvider: 'TEST_fixture',
      reasoningEffort: 'low', developerInstructions: CONTEXT_MARKER },
    capturedMcpServers: {}, limits: { ...original.limits },
  };
  member.capturedMcpCatalog = await readCodexMcpCatalog(member, assertCurrent);
  profile.runtime = { members: [member], ...(profile.runtime!.providerTemplates
    ? { providerTemplates: [structuredClone(member)] } : {}) };
  profile.management = [management];
  assert.equal(profile.teams.length, 1);
  const team = profile.teams[0]!;
  assert.equal(team.members.length, 1); assert.equal(team.members[0]!.name, 'alice');
  assert.equal(team.members[0]!.role, 'lead');
  team.savedSettings = { ...team.savedSettings, cwd: original.cwd, providerId: 'codex', model: selected.model, effort: 'low' };
  const descriptor = record(JSON.parse(await readFile(base.descriptorPath, 'utf8')));
  assert.ok(Array.isArray(descriptor.management) && descriptor.management.length === 1);
  descriptor.management = [{ ...record(descriptor.management[0]), runtimeId: 'codex',
    profileId: management.profileId, configRevision: management.configRevision }];
  const profileBytes = JSON.stringify(profile);
  await writeFile(base.profilePath, profileBytes, { mode: 0o600 });
  readTeamHostProfile(base.profilePath, digest(profileBytes));
  assert.ok(Array.isArray(descriptor.owners) && descriptor.owners.length === 1);
  record(record(record(descriptor.owners[0]).profile).env).LEGACY_AGENT_HOST_PROFILE_SHA256 = digest(profileBytes);
  const descriptorBytes = JSON.stringify(descriptor);
  await writeFile(base.descriptorPath, descriptorBytes, { mode: 0o600 });
  const seeded = await seedDesktopCodexResumeOwner(base.root, profile);
  return { ...base, uiSeed: seeded.uiSeed,
    codexResume: { modelId: selected.id, model: selected.model, displayName: selected.displayName,
      effort: 'medium' as const, catalog, savedSettings: seeded.savedSettings },
    pins: { ...base.pins, profileSha256: digest(profileBytes), descriptorSha256: digest(descriptorBytes),
      codexConfigSha256: digest(finalConfigBytes), codexExecutableSha256: CODEX_SHA256 },
    appEnvironment: desktopBackendEnvironment(base.root, base.node, base.descriptorPath, digest(descriptorBytes)),
  };
}

/** The same offline canonical sidebar seed, after provider selection and before any app/Host. */
export async function seedDesktopCodexResumeOwner(root: string, profile: TeamHostProfile) {
  assert.match(basename(root), /^TEST-desktop-backend-/);
  assert.equal(await realpath(root), root);
  assert.equal(profile.owner.storageRoot, join(root, 'hoststore'));
  assert.equal(profile.teams.length, 1);
  const selected = profile.teams[0]!;
  assert.equal(selected.savedSettings?.providerId, 'codex');
  await assert.rejects(lstat(join(profile.owner.storageRoot, 'teams', selected.binding.teamName, '.host-owner/state.json')), { code: 'ENOENT' });
  const lease = acquireProfileWriterLease(profile.owner.storageRoot);
  try {
    lease.assertCurrent();
    const owner = createFilesystemTeamOwner({ root: profile.owner.storageRoot, binding: selected.binding,
      members: selected.members, grants: selected.grants, savedSettings: selected.savedSettings });
    const team = owner.connect(profile.principalId);
    const subject = 'TEST persisted Host sidebar seed', commandId = 'TEST-ui-offline-seed';
    const receipt = team.execute({ commandId, operation: 'task.create', payload: { subject } });
    assert.equal(receipt.phase, 'completed');
    const tasks = team.listTasks(); assert.equal(tasks.length, 1); assert.equal(tasks[0]!.subject, subject);
    const savedSettings = team.readRoster().savedSettings;
    assert.ok(savedSettings);
    assert.deepEqual(savedSettings, selected.savedSettings);
    await writeFile(join(root, 'ui-seed-receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600, flag: 'wx' });
    return { uiSeed: { taskId: tasks[0]!.id, subject, commandId }, savedSettings };
  } finally { lease.release(); }
}
