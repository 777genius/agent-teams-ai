import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { CapturedProcess, type CapturedProcessPort, type CapturedProcessProfile } from '../../packages/legacy-agent-host/dist/adapters/providers/CapturedProcess.js';
import { captureDesktopNativeExecutable, selectedDesktopRuntime } from './desktop-captured-app.ts';
import { processTable, projectDesktopHarnessFailure } from './desktop-backend-observations.ts';
import { CodexManagementHost } from '../../packages/legacy-agent-host/dist/adapters/providers/CodexManagementHost.js';
import { readCodexMcpCatalog } from '../../packages/legacy-agent-host/dist/adapters/providers/readCodexMcpCatalog.js';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { createFilesystemTeamOwner } from '../../packages/legacy-agent-host/dist/adapters/team/createFilesystemTeamOwner.js';
import { acquireProfileWriterLease } from '../../packages/legacy-agent-host/dist/adapters/profile/ProfileWriterLease.js';
import { CONTEXT_MARKER } from '../../packages/legacy-agent-host/tests/fixtures/native-codex-team/model.ts';
import { desktopBackendEnvironment, digest, fileDigest } from './desktop-backend-fixture.ts';
import { record } from './desktop-resume-records.ts';
import { captureDesktopCodexNativeInputs } from './desktop-source-freeze.ts';
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
  const sourceFlag = process.env.LEGACY_DESKTOP_CODEX_SOURCE_SELECTION;
  assert.ok(sourceFlag === undefined || sourceFlag === '1');
  if (sourceFlag === '1') {
    assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
    assert.equal(process.env.LEGACY_DESKTOP_PROOF_MODE, 'native-resume-ui');
    assert.equal(process.env.LEGACY_DESKTOP_RESUME_PROVIDER, 'codex');
    assert.equal(process.env.LEGACY_DESKTOP_PACKED_CAPTURE_PATH, undefined);
    assert.equal(process.env.LEGACY_DESKTOP_READBACK_ROOT, undefined);
  }
  const candidate = sourceFlag === '1' ? await readDesktopCodexSourceInputs() : undefined;
  assert.equal(base.uiSeed, undefined, 'Codex settings must be selected before the original canonical seed');
  assert.equal(await realpath(base.root), base.root);
  assert.equal(await fileDigest(base.profilePath), base.pins.profileSha256);
  assert.equal(await fileDigest(base.descriptorPath), base.pins.descriptorSha256);
  assert.equal(await realpath(options.executable), options.executable);
  assert.equal(await fileDigest(options.executable), CODEX_SHA256);
  const nativeInputs = await captureDesktopCodexNativeInputs(options.executable);
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
  const preApp: Record<string, unknown>[] = [];
  const runner = candidate ? processTable().filter(row => row.pid === process.pid) : [];
  if (candidate) assert.equal(runner.length, 1);
  const readOwned = async <T>(purpose: 'metadata' | 'catalog',
    action: (factory: (selected: CapturedProcessProfile, current: () => boolean) => CapturedProcessPort) => Promise<T>) => {
    const census = captureDesktopNativeExecutable(options.executable, runner[0]!.pgid);
    assert.deepEqual(selectedDesktopRuntime(options.executable), [], 'no prior native child is adopted');
    const ports: { custody: CapturedProcess; close(): Promise<boolean>; launches: number }[] = [];
    type Phase = 'action' | 'launch' | 'census' | 'match' | 'birth' | 'group' |
      'cleanup-close' | 'port-count' | 'launch-count' | 'census-count' | 'remaining' | 'global-absence';
    let phase: Phase = 'action';
    let observedChild: ReturnType<CapturedProcess['launch']> | undefined;
    const failure = (error: unknown) => {
      let returned: boolean | 'unavailable' = 'unavailable';
      let positivePid: boolean | 'unavailable' = 'unavailable';
      let terminal: 'pending' | 'exit-zero' | 'exit-nonzero' | 'signal' | 'unavailable' = 'unavailable';
      try {
        returned = observedChild !== undefined;
        positivePid = typeof observedChild?.pid === 'number' && Number.isSafeInteger(observedChild.pid) && observedChild.pid > 0;
        if (observedChild) terminal = observedChild.signalCode !== null ? 'signal' :
          observedChild.exitCode === null ? 'pending' : observedChild.exitCode === 0 ? 'exit-zero' : 'exit-nonzero';
      } catch { /* Diagnostic values cannot replace the original error. */ }
      return { error, phase, returned, positivePid, terminal };
    };
    let firstFailure: ReturnType<typeof failure> | undefined;
    let cleanupFailure: ReturnType<typeof failure> | undefined;
    let cleanup: 'confirmed' | 'unconfirmed' | 'unavailable' = 'unavailable';
    let value!: T;
    try {
      value = await action((selected, current) => {
        assert.deepEqual(selected.executable, { path: options.executable, sha256: CODEX_SHA256 });
        const custody = new CapturedProcess(selected, current);
        let closing: Promise<boolean> | undefined;
        const port = { custody, launches: 0, close: () => closing ??= custody.confirmStopped() };
        ports.push(port);
        return {
          launch(request) {
            phase = 'launch';
            let child: ReturnType<CapturedProcess['launch']>;
            try {
              child = custody.launch(request); port.launches++;
              observedChild = child;
            } catch (error) { firstFailure ??= failure(error); throw error; }
            try {
              phase = 'census';
              census.observe();
              phase = 'match';
              const found = census.captured().filter(row => row.pid === child.pid);
              assert.equal(found.length, 1, 'same returned native child, observed before caller input');
              phase = 'birth';
              assert.ok(found[0]!.birth && found[0]!.ancestry.length > 0);
              phase = 'group';
              assert.equal(found[0]!.pgid, child.pid);
            } catch (error) {
              firstFailure ??= failure(error);
              custody.seal(); void port.close().catch(() => {}); throw error;
            }
            phase = 'action';
            return child;
          },
          seal: () => custody.seal(), isRunning: () => custody.isRunning(), confirmStopped: port.close,
        };
      });
    } catch (error) {
      firstFailure ??= failure(error);
    } finally {
      try {
        phase = 'cleanup-close';
        for (const port of ports) port.custody.seal();
        const settled = await Promise.allSettled(ports.map(port => port.close()));
        cleanup = settled.every(result => result.status === 'fulfilled' && result.value === true)
          ? 'confirmed' : 'unconfirmed';
        assert.ok(settled.every(value => value.status === 'fulfilled' && value.value === true),
          'same original disposal must establish cleanup, including observer failure');
        phase = 'port-count';
        assert.equal(ports.length, 1);
        phase = 'launch-count';
        assert.equal(ports[0]!.launches, 1);
        phase = 'census-count';
        assert.equal(census.captured().length, 1);
        phase = 'remaining';
        assert.deepEqual(census.remaining(), []);
        phase = 'global-absence';
        assert.deepEqual(selectedDesktopRuntime(options.executable), []);
        preApp.push({ purpose, children: census.captured(), cleanup: true });
      } catch (error) { cleanupFailure = failure(error); }
    }
    if (firstFailure || cleanupFailure) {
      try {
        const count = (amount: number) => amount === 0 ? 0 : amount === 1 ? 1 : 'multiple';
        const sources = ['scripts/legacy-agent-host/desktop-codex-resume-fixture.ts',
          'packages/legacy-agent-host/dist/adapters/providers/CapturedProcess.js',
          'packages/legacy-agent-host/dist/adapters/providers/readCodexMcpCatalog.js'];
        const project = (retained: ReturnType<typeof failure> | undefined) => retained ? {
          phase: retained.phase, returned: retained.returned, positivePid: retained.positivePid,
          terminal: retained.terminal,
          failure: projectDesktopHarnessFailure(retained.error, dirname(dirname(import.meta.dirname)), sources),
        } : null;
        const line = JSON.stringify({ kind: 'C10_PRE_APP_FAILURE', purpose,
          ports: count(ports.length), launches: ports.length === 1 ? count(ports[0]!.launches) :
            ports.length === 0 ? 0 : 'multiple',
          captured: count(census.captured().length), cleanup,
          first: project(firstFailure), cleanupFailure: project(cleanupFailure) });
        console.error(Buffer.byteLength(line, 'utf8') <= 4096 ? line :
          JSON.stringify({ kind: 'C10_PRE_APP_FAILURE', purpose, unavailable: true }));
      } catch { /* Failure-only diagnostics cannot replace either original failure. */ }
      if (firstFailure && cleanupFailure)
        throw new AggregateError([firstFailure.error, cleanupFailure.error], 'C10 pre-App observation and cleanup failed');
      throw (firstFailure ?? cleanupFailure)!.error;
    }
    return value;
  };
  const isCurrent = () => { try { assertCurrent(); return true; } catch { return false; } };
  const catalog = candidate
    ? await readOwned('metadata', factory => new CodexManagementHost(management, isCurrent, factory).read(true))
    : await new CodexManagementHost(management, () => {
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
  member.capturedMcpCatalog = candidate
    ? await readOwned('catalog', factory => readCodexMcpCatalog(member, assertCurrent, undefined, factory))
    : await readCodexMcpCatalog(member, assertCurrent);
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
  const appEnvironment = desktopBackendEnvironment(base.root, base.node, base.descriptorPath, digest(descriptorBytes));
  const alias = candidate ? await captureDesktopCodexSourceAlias(base.root, options.executable) : undefined;
  if (candidate) {
    assert.ok(alias);
    appEnvironment.CODEX_CLI_PATH = ''; appEnvironment.PATH = alias.directory + ':' + appEnvironment.PATH;
  }
  return { ...base, uiSeed: seeded.uiSeed,
    codexResume: { modelId: selected.id, model: selected.model, displayName: selected.displayName,
      effort: 'medium' as const, catalog, savedSettings: seeded.savedSettings, nativeInputs,
      ...(candidate && alias ? { sourceSelection: { candidate, preApp, alias } } : {}) },
    pins: { ...base.pins, profileSha256: digest(profileBytes), descriptorSha256: digest(descriptorBytes),
      codexConfigSha256: digest(finalConfigBytes), codexExecutableSha256: CODEX_SHA256,
      codexCodeModeHostSha256: nativeInputs[1]!.sha256 },
    appEnvironment,
  };
}

/** One fixture-owned PATH name; all native profile and census paths stay canonical. */
async function captureDesktopCodexSourceAlias(root: string, executable: string) {
  const directory = join(root, 'codex-source-bin'), path = join(directory, 'codex');
  assert.equal(await realpath(root), root); assert.equal(await realpath(executable), executable);
  await mkdir(directory, { mode: 0o700 }); await symlink(executable, path);
  const directoryStat = await lstat(directory), link = await lstat(path), target = await lstat(executable);
  const identity = (value: typeof link) => ({ dev: value.dev, ino: value.ino, mode: value.mode, uid: value.uid,
    gid: value.gid, nlink: value.nlink, size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs });
  assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink());
  assert.equal(directoryStat.mode & 0o777, 0o700); assert.equal(directoryStat.uid, process.getuid?.());
  assert.ok(link.isSymbolicLink() && link.nlink === 1);
  assert.ok(target.isFile() && !target.isSymbolicLink() && target.nlink === 1);
  const evidence = { path, directory, target: executable, sha256: CODEX_SHA256,
    directoryIdentity: identity(directoryStat), linkIdentity: identity(link), targetIdentity: identity(target) };
  const verify = async () => {
    assert.equal(await realpath(root), root); assert.equal(await realpath(directory), directory);
    assert.deepEqual(identity(await lstat(directory)), evidence.directoryIdentity);
    assert.deepEqual(await readdir(directory), ['codex']);
    assert.deepEqual(identity(await lstat(path)), evidence.linkIdentity);
    assert.equal(await readlink(path), executable); assert.equal(await realpath(path), executable);
    assert.equal(await realpath(executable), executable);
    assert.deepEqual(identity(await lstat(executable)), evidence.targetIdentity);
    assert.equal(await fileDigest(executable), CODEX_SHA256);
    assert.deepEqual(identity(await lstat(executable)), evidence.targetIdentity);
    assert.deepEqual(identity(await lstat(path)), evidence.linkIdentity);
    assert.deepEqual(identity(await lstat(directory)), evidence.directoryIdentity);
  };
  await verify(); return { directory, evidence, verify };
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

const CODEX_CANDIDATE_ARCHIVE = {
  name: 'codex-npm-darwin-arm64-0.169.0.tgz', bytes: 153831622,
  sha256: 'd67d443253294438a21fde15753d7c1174e6a32147d842eb84428479d664c93d',
};
const CODEX_CANDIDATE_PREFIX = 'package/vendor/aarch64-apple-darwin/';
const CODEX_CANDIDATE_MANIFEST = 'c208ac0fae6c647b74a24733ff69673e309c4408839b8e27e499754069087d39';

/** Closed copy of the qualified original candidate-input parser; no native command is run. */
export function parseDesktopCodexSourceInputs(value: unknown) {
  const pins = record(value);
  assert.deepEqual(Object.keys(pins).sort(), ['archive', 'files', 'kind', 'target', 'version']);
  assert.equal(pins.kind, 'TEST_CODEX_CANDIDATE_INPUTS_V1');
  assert.equal(pins.version, '0.169.0'); assert.equal(pins.target, 'aarch64-apple-darwin');
  assert.deepEqual(pins.archive, CODEX_CANDIDATE_ARCHIVE);
  assert.ok(Array.isArray(pins.files) && pins.files.length === 43);
  const files = pins.files.map(value => {
    const row = record(value);
    assert.deepEqual(Object.keys(row).sort(), ['bytes', 'mode', 'path', 'sha256']);
    assert.ok(typeof row.path === 'string' && row.path.startsWith('package/') &&
      row.path.length <= 4096 && !/[\\\0-\x1f\x7f]/.test(row.path) &&
      row.path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'));
    assert.ok(typeof row.bytes === 'number' && Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= 1024 ** 3);
    assert.ok(typeof row.mode === 'number' && Number.isSafeInteger(row.mode) && row.mode >= 0 && row.mode <= 0o777);
    assert.equal(typeof row.sha256, 'string'); assert.match(String(row.sha256), /^[a-f0-9]{64}$/);
    return { path: row.path, bytes: row.bytes, mode: row.mode, sha256: String(row.sha256) };
  });
  assert.deepEqual(files.map(row => row.path), [...new Set(files.map(row => row.path))].sort());
  assert.ok(files.reduce((sum, row) => sum + row.bytes, 0) <= 2 * 1024 ** 3);
  const canonical = { kind: pins.kind, version: pins.version, target: pins.target,
    archive: CODEX_CANDIDATE_ARCHIVE, files };
  assert.equal(digest(JSON.stringify(canonical)), CODEX_CANDIDATE_MANIFEST,
    'all 43 original qualified candidate pins, not just the main executable');
  return { version: '0.169.0' as const, target: 'aarch64-apple-darwin' as const,
    archive: { ...CODEX_CANDIDATE_ARCHIVE }, files };
}

async function streamDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function readDesktopCodexSourceInputs() {
  const supplied = process.env.LEGACY_CODEX_CANDIDATE_INPUTS;
  assert.ok(supplied && supplied.endsWith('/codex-0.169.0/input-pins.json'));
  assert.equal(await realpath(supplied), supplied);
  const stage = dirname(supplied);
  assert.match(stage, /^\/private\/tmp\/TEST-stage1-inputs-[^/]+\/codex-0\.169\.0$/);
  const directory = await lstat(stage);
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink() &&
    (directory.mode & 0o777) === 0o700 && directory.uid === process.getuid?.());
  const receiptStat = await lstat(supplied);
  assert.ok(receiptStat.isFile() && !receiptStat.isSymbolicLink() && receiptStat.nlink === 1 && receiptStat.size <= 256 * 1024);
  const receiptBytes = await readFile(supplied), pins = parseDesktopCodexSourceInputs(JSON.parse(receiptBytes.toString('utf8')));
  assert.equal(receiptBytes.length, receiptStat.size);
  const archive = join(stage, pins.archive.name), archiveStat = await lstat(archive);
  assert.ok(archiveStat.isFile() && !archiveStat.isSymbolicLink() && archiveStat.nlink === 1);
  assert.equal(archiveStat.size, pins.archive.bytes);
  assert.equal(await streamDigest(archive), pins.archive.sha256);
  const archiveCurrent = async () => {
    assert.equal(await realpath(archive), archive);
    const current = await lstat(archive);
    for (const key of ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs'] as const)
      assert.equal(current[key], archiveStat[key]);
  };
  await archiveCurrent();
  const verify = async (root: string, selected: typeof pins.files, installed: boolean) => {
    assert.equal(await realpath(root), root);
    const names: string[] = []; let visited = 0;
    const walk = async (relative: string, depth: number): Promise<void> => {
      assert.ok(++visited <= 1024 && depth <= 16);
      const path = join(root, relative), info = await lstat(path);
      assert.equal(await realpath(path), path);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        for (const name of (await readdir(path)).sort()) await walk(relative ? relative + '/' + name : name, depth + 1);
      } else {
        assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
        assert.ok(names.length < 512); names.push(relative);
      }
    };
    await walk('', 0);
    assert.deepEqual(names.sort(), selected.map(row => row.path).sort(), 'complete selected package closure');
    for (const row of selected) {
      const path = join(root, row.path), before = await lstat(path);
      assert.equal(before.mode & 0o7000, 0); assert.equal(before.mode & 0o022, 0);
      assert.equal(before.size, row.bytes);
      if (installed) assert.equal(Boolean(before.mode & 0o111), Boolean(row.mode & 0o111));
      else assert.equal(before.mode & 0o777, row.mode);
      assert.equal(await streamDigest(path), row.sha256);
      const after = await lstat(path);
      for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const) assert.equal(after[key], before[key]);
    }
  };
  const verifyCandidate = async () => {
    await archiveCurrent();
    assert.equal(await realpath(supplied), supplied); assert.equal(await fileDigest(supplied), digest(receiptBytes));
    await verify(join(stage, 'package'), pins.files.map(row => ({ ...row, path: row.path.slice('package/'.length) })), false);
    await archiveCurrent();
  };
  await verifyCandidate();
  const npm = record(JSON.parse(await readFile(join(stage, 'package/package.json'), 'utf8')));
  assert.equal(npm.name, '@openai/codex'); assert.equal(npm.version, '0.169.0-darwin-arm64');
  assert.deepEqual(npm.os, ['darwin']); assert.deepEqual(npm.cpu, ['arm64']);
  const layout = record(JSON.parse(await readFile(join(stage, CODEX_CANDIDATE_PREFIX, 'codex-package.json'), 'utf8')));
  assert.equal(layout.layoutVersion, 1); assert.equal(layout.version, '0.169.0');
  assert.equal(layout.target, pins.target); assert.equal(layout.variant, 'codex');
  assert.equal(layout.entrypoint, 'bin/codex'); assert.equal(layout.resourcesDir, 'codex-resources');
  assert.equal(layout.pathDir, 'codex-path');
  const vendorFiles = pins.files.filter(row => row.path.startsWith(CODEX_CANDIDATE_PREFIX))
    .map(row => ({ ...row, path: row.path.slice(CODEX_CANDIDATE_PREFIX.length) }));
  const pair = ['bin/codex', 'bin/codex-code-mode-host'].map(path => {
    const matches = vendorFiles.filter(row => row.path === path);
    assert.equal(matches.length, 1); assert.ok(matches[0]!.mode & 0o111);
    return { relativePath: path, sha256: matches[0]!.sha256 };
  });
  return {
    evidence: { ...pins, manifestSha256: digest(receiptBytes), canonicalSha256: CODEX_CANDIDATE_MANIFEST },
    pair, verifyCandidate,
    async verifyInstalled(binary: string) {
      assert.equal(basename(binary), 'codex'); assert.equal(basename(dirname(binary)), 'bin');
      const root = dirname(dirname(binary));
      await verify(root, vendorFiles, true);
      return pair.map(row => ({ path: join(root, row.relativePath), sha256: row.sha256 }));
    },
  };
}

