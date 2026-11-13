import { uploadNativeMessagePdf, readNativeMessagePdf } from './fixtures/native-message-pdf.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { CONTEXT_MARKER, record, startNativeTeamModel } from './fixtures/native-claude-team/model.ts';
import { fileHash, tick, treeHash, startHost } from './fixtures/native-host.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { ClaudeConfig } from '@agent-teams/provider-implementations/claude';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

const DONOR_COMMIT = '1d0f97f55de566036c970eab4f36b84620afdb3f';
const DONOR_ARTIFACT = 'vendor/provider-migration/opencode-v2-host-9ede557c/agent-teams-provider-implementations-0.0.0.tgz';
const DONOR_SHA256 = 'fc8a821aff5b96b649647dac3853c831acf83d1555a480dc1f9645006600cb89';
const CONTRACTS_SHA256 = 'aaf9506473f6a2868a375a6087e1b4edc561b38f34101ef7a8703a73bb2674db';
const CURRENT_SHA256 = '73c7034aef1283ee694114d2a31d12383370286b45c18120958ca0edef789957';

function donorSourceCurrent(repo: string): void {
  assert.equal(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), DONOR_COMMIT);
  assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain=v1', '--untracked-files=no'], { encoding: 'utf8' }).trim(), '');
}

/** Inspection only: one source-derived projection must match the genuine old hash before current D is called. */
async function inspectOriginalCheckpoint(options: {
  repo: string; donor: string; root: string; profile: TeamHostProfile;
  selection: unknown; reference: string; nativeTools: readonly string[];
}) {
  const { repo, donor, root, reference } = options;
  const oldDist = join(donor, 'packages/legacy-agent-host/dist');
  const originalProfileBytes = await readFile(join(root, 'profile.json'));
  const { readTeamHostProfile } = await import(pathToFileURL(join(oldDist, 'composition/readProfile.js')).href) as typeof import('../dist/composition/readProfile.js');
  const profile = readTeamHostProfile(join(root, 'profile.json'), hash(originalProfileBytes));
  assert.deepEqual(profile.owner, options.profile.owner);
  const oldProvider = await realpath(join(donor, 'packages/legacy-agent-host/node_modules/@agent-teams/provider-implementations'));
  const currentProvider = await realpath(join(repo, 'packages/legacy-agent-host/node_modules/@agent-teams/provider-implementations'));
  const { FileCheckpointStorage } = await import(pathToFileURL(join(oldDist, 'adapters/runtime/FileCheckpointStorage.js')).href) as typeof import('../dist/adapters/runtime/FileCheckpointStorage.js');
  const payload = new FileCheckpointStorage(join(root, 'store')).readCheckpointPayload(reference);
  const opaque = record(payload.opaque);
  assert.equal(opaque.engine, '0.3.305');
  assert.equal(typeof opaque.nativeSession, 'string');
  assert.match(String(opaque.nativeSession), /^[a-zA-Z0-9-]+$/u);
  const checkpointPath = join(root, 'store/runtime-checkpoints', reference + '.json');
  const bytes = await readFile(checkpointPath);
  assert.ok(bytes.length > 0 && bytes.length <= 8 * 1024 * 1024);
  await mkdir(join(root, 'frozen'), { mode: 0o700 });
  await writeFile(join(root, 'frozen/original-checkpoint.json'), bytes, { mode: 0o600, flag: 'wx' });
  await writeFile(join(root, 'frozen/original-profile.json'), originalProfileBytes, { mode: 0o600, flag: 'wx' });
  const originalOwner = record(JSON.parse(originalProfileBytes.toString('utf8'))).owner;
  assert.deepEqual(originalOwner, profile.owner);
  assert.equal(payload.profileId, profile.owner.profileId);
  assert.equal(payload.sourceBinding.backendId, profile.owner.ownerId);
  const { applyLaunchConfiguration } = await import(pathToFileURL(join(oldDist, 'composition/launchConfiguration.js')).href) as typeof import('../dist/composition/launchConfiguration.js');
  const base = profile.runtime!.members[0]!;
  const { FileTeamRuntimeBindings } = await import(pathToFileURL(join(oldDist, 'adapters/team/FileTeamRuntimeBindings.js')).href) as typeof import('../dist/adapters/team/FileTeamRuntimeBindings.js');
  const { TeamOwnerStore } = await import(pathToFileURL(join(oldDist, 'adapters/team/TeamOwnerStore.js')).href) as typeof import('../dist/adapters/team/TeamOwnerStore.js');
  const { runtimeDigest } = await import(pathToFileURL(join(oldDist, 'runtime/identity.js')).href) as typeof import('../dist/runtime/identity.js');
  const delivery = profile.teams[0]!.members[0]!.delivery;
  assert.ok(delivery);
  const retained = new FileTeamRuntimeBindings(new TeamOwnerStore(join(root, 'store'), profile.teams[0]!.binding.teamName)).current(delivery);
  assert.ok(retained);
  const selected = applyLaunchConfiguration(base, options.selection);
  assert.ok(selected.provider === 'claude');
  selected.generation = retained.generation;
  assert.equal(payload.sourceConfig.configRevision, selected.configRevision);
  assert.equal(payload.sourceConfig.sessionId, selected.sessionId);
  assert.equal(retained.baseConfigurationDigest, runtimeDigest(base));
  assert.equal(retained.configurationDigest, runtimeDigest(selected));
  assert.deepEqual(retained.binding, payload.sourceBinding);
  const originalLaunch = await readFile(join(root, 'store/teams', profile.teams[0]!.binding.teamName, '.host-owner/launches', runtimeDigest(delivery.runId) + '.json'));
  await writeFile(join(root, 'frozen/original-launch.json'), originalLaunch, { mode: 0o600, flag: 'wx' });
  const { claudeSessionExists } = await import(pathToFileURL(join(oldDist, 'adapters/providers/claudeSessionExists.js')).href) as typeof import('../dist/adapters/providers/claudeSessionExists.js');
  assert.equal(claudeSessionExists(join(root, 'config'), selected.cwd, String(opaque.nativeSession)), true);
  const projects = await readdir(join(root, 'config/projects'), { withFileTypes: true });
  assert.ok(projects.length <= 16);
  const histories: string[] = [];
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    const file = join(root, 'config/projects', project.name, String(opaque.nativeSession) + '.jsonl');
    const found = await lstat(file).catch(error => { if (error?.code === 'ENOENT') return undefined; throw error; });
    if (found) { assert.ok(found.isFile() && !found.isSymbolicLink()); assert.equal(await realpath(file), file); histories.push(file); }
  }
  assert.equal(histories.length, 1);
  const historyPath = histories[0]!, history = await readFile(historyPath);
  assert.ok(history.length > 0 && history.length <= 64 * 1024 * 1024);
  await writeFile(join(root, 'frozen/original-native-prefix.jsonl'), history, { mode: 0o600, flag: 'wx' });
  const { memberInitialInstructions } = await import(pathToFileURL(join(oldDist, 'composition/TeamLaunchComposition.js')).href) as typeof import('../dist/composition/TeamLaunchComposition.js');
  const { createTeamMcpTools } = await import(pathToFileURL(join(oldDist, 'mcp/tools.js')).href) as typeof import('../dist/mcp/tools.js');
  const { resolveAgentAttachmentCapability } = await import(pathToFileURL(join(oldDist, 'attachments/capabilities.js')).href) as typeof import('../dist/attachments/capabilities.js');
  const calls = { metadata: 0, sessionExists: 0, probe: 0, launch: 0, close: 0, attachment: 0, subagentAuthorize: 0, subagentObserve: 0 };
  const forbiddenMetadata = () => { calls.metadata++; throw new Error('TEST metadata-only port invoked'); };
  // These unusable ports expose only frozen source catalog order. The actual native catalog determines membership.
  const metadataPort = new Proxy(forbiddenMetadata, { get: () => forbiddenMetadata });
  const metadataConnection = new Proxy({}, { get: () => metadataPort }) as Parameters<typeof createTeamMcpTools>[0];
  const actual = new Set(options.nativeTools.filter(name => name.startsWith('mcp__team__')).map(name => name.slice('mcp__team__'.length)));
  assert.ok(actual.size > 0);
  const required = createTeamMcpTools(metadataConnection).list().map(tool => tool.name).filter(name => actual.has(name));
  assert.deepEqual([...required].sort(), [...actual].sort(), 'Every actual native tool has one frozen-source catalog position');
  const capability = resolveAgentAttachmentCapability({ providerId: 'anthropic', model: selected.model });
  const mimeTypes = [
    ...(capability.supportsImages ? capability.supportedImageMimeTypes : []),
    ...(capability.supportsFiles ? capability.supportedFileMimeTypes : []),
    ...(capability.supportsVideo ? capability.supportedVideoMimeTypes : []),
  ];
  const attachmentRevision = hash(JSON.stringify({
    version: 1, provider: selected.provider, model: selected.model, mimeTypes,
    maxImages: capability.maxImages, maxFiles: capability.maxFiles, maxVideos: capability.maxVideos,
    maxBytesPerImage: capability.maxBytesPerImage, maxBytesPerFile: capability.maxBytesPerFile,
    maxBytesPerVideo: capability.maxBytesPerVideo, maxBytesTotal: capability.maxBytesTotal,
  }));
  const member = profile.teams[0]!.members[0]!;
  const nativeOptions = selected.nativeOptions;
  // Exact createClaudeSubagents selection from the frozen old composition; callbacks remain forbidden.
  const subagentTools = selected.nativeTools.filter(name => !/^(Team|Task|TodoWrite|Agent|Cron|Schedule|SendMessage$|ListAgents$|mcp__)/.test(name));
  const config: ClaudeConfig = {
    sessionRef: selected.sessionId,
    trustedBinding: [payload.sourceBinding.backendId, payload.sourceBinding.teamId, payload.sourceBinding.runId, selected.memberId].join('/'),
    cwd: selected.cwd, model: selected.model, accountBinding: selected.accountBinding,
    configRevision: selected.configRevision, environment: { ...selected.environment },
    ...(selected.extraArgs ? { extraArgs: [...selected.extraArgs] } : {}),
    ...(selected.configNamespace ? { configNamespace: selected.configNamespace } : {}),
    nativeOptions: {
      ...(nativeOptions?.permissionMode === undefined ? {} : { permissionMode: nativeOptions.permissionMode }),
      ...(nativeOptions?.allowDangerouslySkipPermissions === undefined ? {} : { allowDangerouslySkipPermissions: nativeOptions.allowDangerouslySkipPermissions }),
      ...(nativeOptions?.settingSources === undefined ? {} : { settingSources: nativeOptions.settingSources }),
      ...(nativeOptions?.effort === undefined ? {} : { effort: nativeOptions.effort }),
      ...(nativeOptions?.fastMode === undefined ? {} : { fastMode: nativeOptions.fastMode }),
      ...(nativeOptions?.context === undefined ? {} : { context: nativeOptions.context }),
      projectInstructions: { append: [
        memberInitialInstructions(member.name, member.role, profile.teams[0]!.binding.teamName, selected.cwd),
        nativeOptions?.projectInstructions?.append,
      ].filter(Boolean).join('\n\n') },
    },
    ...(subagentTools.length ? { subagents: {
      mode: 'do' as const, tools: subagentTools,
      authorize: async () => { calls.subagentAuthorize++; throw new Error('Unexpected subagent authorization'); },
      observe: async () => { calls.subagentObserve++; throw new Error('Unexpected subagent observation'); },
    } } : {}),
    nativeTools: [...new Set([...selected.nativeTools, ...(subagentTools.length ? ['Agent'] : [])])],
    autoAllowedTools: [...new Set([...selected.autoAllowedTools, ...required.map(name => 'mcp__team__' + name)])],
    requiredTools: { team: required },
    // Negative-only port: no connection or authentication is claimed. Any native/probe callback fails this inspection.
    mcpServers: { team: { type: 'http', url: 'http://127.0.0.1:1/TEST-never-contacted' } },
    limits: { ...selected.limits },
    attachments: { model: selected.model, revision: attachmentRevision, mimeTypes,
      resolve: async () => { calls.attachment++; throw new Error('Unexpected attachment resolution'); } },
    sessionExists: async () => { calls.sessionExists++; throw new Error('Unexpected native backing access'); },
    probe: async () => { calls.probe++; throw new Error('Unexpected native probe'); },
    custody: {
      launch: () => { calls.launch++; throw new Error('Unexpected native allocation'); },
      confirmStopped: async () => { calls.close++; throw new Error('Unexpected native cleanup'); },
    },
  };
  const oldConfiguration = await import(pathToFileURL(join(oldProvider, 'dist/features/provider-session-implementation/adapters/claude-sdk/config.js')).href) as { compatibility(value: ClaudeConfig): string };
  const oldCompatibility = oldConfiguration.compatibility(config);
  assert.equal(oldCompatibility, opaque.compatibility, 'One source-derived complete old projection matches the actual immutable checkpoint');
  const sdk = createRequire(join(currentProvider, 'dist/claude.js')).resolve('@anthropic-ai/claude-agent-sdk');
  assert.equal(String(record(JSON.parse(await readFile(join(dirname(sdk), 'package.json'), 'utf8'))).version), '0.3.305');
  const originalIdentity = {
    sourceBinding: payload.sourceBinding, sourceConfig: payload.sourceConfig, originalOwner,
    checkpointSha256: hash(bytes), nativePrefixSha256: hash(history), nativePrefixBytes: history.length,
    baseConfigurationDigest: retained.baseConfigurationDigest, selectedConfigurationDigest: retained.configurationDigest,
    native: selected.executable, profileSha256: await fileHash(join(root, 'profile.json')),
    originalCompatibility: oldCompatibility, originalLaunchSha256: hash(originalLaunch),
  };
  await writeFile(join(root, 'frozen/original-source-identity.json'), JSON.stringify(originalIdentity, null, 2), { mode: 0o600, flag: 'wx' });
  const { openClaudeSession } = await import(pathToFileURL(join(currentProvider, 'dist/claude.js')).href) as typeof import('@agent-teams/provider-implementations/claude');
  const current = await openClaudeSession({ ...config, executablePath: selected.executable.path }, payload.opaque);
  assert.deepEqual(current, { ok: false, code: 'checkpoint-incompatible' });
  assert.deepEqual(calls, { metadata: 0, sessionExists: 0, probe: 0, launch: 0, close: 0, attachment: 0, subagentAuthorize: 0, subagentObserve: 0 });
  assert.deepEqual(await readFile(checkpointPath), bytes);
  const proof = {
    ...originalIdentity, currentRefusal: current, calls,
    compiledEntryEqual: await fileHash(join(oldDist, 'cli.js')) === await fileHash(join(repo, 'packages/legacy-agent-host/dist/cli.js')),
    oldEntrySha256: await fileHash(join(oldDist, 'cli.js')),
    currentEntrySha256: await fileHash(join(repo, 'packages/legacy-agent-host/dist/cli.js')),
    originalNodeSha256: profile.owner.nodeSha256, currentNodeSha256: await fileHash(process.execPath),
    ordinaryCurrentMainRouteQualified: false, currentHostHandshakeQualified: false,
    mainHandle: 'not-produced-by-standalone-fixture',
  };
  assert.equal(proof.originalNodeSha256, proof.currentNodeSha256);
  assert.equal(proof.oldEntrySha256, profile.owner.hostEntrySha256);
  await writeFile(join(root, 'frozen/source-identity.json'), JSON.stringify(proof, null, 2), { mode: 0o600, flag: 'wx' });
  return { proof, async verify() {
    assert.deepEqual(await readFile(checkpointPath), bytes);
    assert.deepEqual((await readFile(historyPath)).subarray(0, history.length), history);
    assert.equal(await fileHash(join(root, 'profile.json')), proof.profileSha256);
    assert.equal(await fileHash(selected.executable.path), selected.executable.sha256);
    assert.equal(await fileHash(join(oldDist, 'cli.js')), proof.oldEntrySha256);
    assert.equal(await fileHash(join(repo, 'packages/legacy-agent-host/dist/cli.js')), proof.currentEntrySha256);
  } };
}

test('standalone Host applies selected model/effort to actual native requests and recovers original launch receipts', { timeout: 180_000 }, async (t) => {
  assert.equal(process.env.LEGACY_NATIVE_CLAUDE_HOST_GO, '1', 'separate root GO required');
  const repo = resolve(import.meta.dirname, '../../..');
  const selectedDonor = process.env.LEGACY_NATIVE_CLAUDE_CHECKPOINT_DONOR;
  const donor = selectedDonor === undefined ? undefined : await realpath(selectedDonor);
  if (donor) { assert.equal(donor, join(repo, '.stage1-checkpoint-donor')); donorSourceCurrent(donor); }
  const selectedRepo = donor ?? repo;
  const pkg = join(selectedRepo, 'packages/legacy-agent-host');
  const helpers = donor
    ? await import(pathToFileURL(join(pkg, 'tests/fixtures/native-host.ts')).href) as typeof import('./fixtures/native-host.ts')
    : { startHost };
  const oracle = donor
    ? await import(pathToFileURL(join(pkg, 'tests/fixtures/native-claude-team/model.ts')).href) as typeof import('./fixtures/native-claude-team/model.ts')
    : { startNativeTeamModel };
  const pdf = donor
    ? await import(pathToFileURL(join(pkg, 'tests/fixtures/native-message-pdf.ts')).href) as typeof import('./fixtures/native-message-pdf.ts')
    : { uploadNativeMessagePdf, readNativeMessagePdf };
  const node = await realpath(join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node'));
  assert.equal(await realpath(process.execPath), node);
  const entry = join(pkg, 'dist/cli.js');
  const artifact = process.env.LEGACY_NATIVE_PROVIDER_ARTIFACT;
  assert.ok(artifact);
  const artifacts = {
    node: { path: node, sha256: await fileHash(node) },
    provider: { path: await realpath(resolve(selectedRepo, artifact)), sha256: '' },
    host: { entry, entrySha256: await fileHash(entry), sourceSha256: await treeHash(join(pkg, 'src'), '.ts'), distSha256: await treeHash(join(pkg, 'dist'), '.js') },
    native: { path: '', sha256: '' },
    sdk: { path: '', sha256: '', version: '' },
    fixtureSources: {
      test: await fileHash(import.meta.filename),
      model: await fileHash(join(pkg, 'tests/fixtures/native-claude-team/model.ts')),
      pdf: await fileHash(join(pkg, 'tests/fixtures/native-message-pdf.ts')),
      helper: await fileHash(join(pkg, 'tests/fixtures/native-host.ts')),
    },
  };
  artifacts.provider.sha256 = await fileHash(artifacts.provider.path);
  assert.match(process.env.LEGACY_NATIVE_PROVIDER_SHA256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(artifacts.provider.sha256, process.env.LEGACY_NATIVE_PROVIDER_SHA256);
  for (const [actual, expected] of [
    [artifacts.host.sourceSha256, process.env.LEGACY_NATIVE_HOST_SOURCE_SHA256],
    [artifacts.host.distSha256, process.env.LEGACY_NATIVE_HOST_DIST_SHA256],
  ]) { assert.match(expected ?? '', /^[a-f0-9]{64}$/); assert.equal(actual, expected); }
  const currentArtifact = process.env.LEGACY_NATIVE_CURRENT_PROVIDER_ARTIFACT;
  if (donor) assert.match(currentArtifact ?? '', /^vendor\/provider-migration\/[a-z0-9-]+\/agent-teams-provider-implementations-0\.0\.0\.tgz$/u);
  const donorInputs = donor ? {
    donorCommit: DONOR_COMMIT,
    providerDistSha256: await treeHash(await realpath(join(pkg, 'node_modules/@agent-teams/provider-implementations/dist')), '.js'),
    contractsSha256: await fileHash(join(donor, dirname(DONOR_ARTIFACT), 'agent-teams-provider-session-contracts-0.0.0.tgz')),
    currentProviderDistSha256: await treeHash(await realpath(join(repo, 'packages/legacy-agent-host/node_modules/@agent-teams/provider-implementations/dist')), '.js'),
    currentProviderSha256: await fileHash(resolve(repo, currentArtifact!)),
    currentSdkSha256: await fileHash(createRequire(await realpath(join(repo, 'packages/legacy-agent-host/node_modules/@agent-teams/provider-implementations/dist/claude.js'))).resolve('@anthropic-ai/claude-agent-sdk')),
    currentHostSourceSha256: await treeHash(join(repo, 'packages/legacy-agent-host/src'), '.ts'),
    currentHostDistSha256: await treeHash(join(repo, 'packages/legacy-agent-host/dist'), '.js'),
  } : undefined;
  if (donorInputs) {
    assert.equal(artifact, DONOR_ARTIFACT); assert.equal(artifacts.provider.sha256, DONOR_SHA256);
    assert.equal(donorInputs.contractsSha256, CONTRACTS_SHA256);
    assert.equal(donorInputs.currentProviderSha256, CURRENT_SHA256);
    assert.equal(donorInputs.providerDistSha256, process.env.LEGACY_NATIVE_PROVIDER_DIST_SHA256);
    assert.equal(donorInputs.currentProviderDistSha256, process.env.LEGACY_NATIVE_CURRENT_PROVIDER_DIST_SHA256);
  }
  // Resolve exactly as the selected original SDK query does; never select a PATH executable.
  const providerEntry = donor
    ? await realpath(join(pkg, 'node_modules/@agent-teams/provider-implementations/dist/claude.js'))
    : import.meta.resolve('@agent-teams/provider-implementations/claude');
  const providerRequire = createRequire(providerEntry);
  const sdk = providerRequire.resolve('@anthropic-ai/claude-agent-sdk');
  artifacts.sdk.path = await realpath(sdk);
  artifacts.sdk.sha256 = await fileHash(artifacts.sdk.path);
  artifacts.sdk.version = String(record(JSON.parse(await readFile(join(dirname(sdk), 'package.json'), 'utf8')) as unknown).version);
  assert.equal(artifacts.sdk.version, '0.3.305');
  if (donorInputs) assert.equal(artifacts.sdk.sha256, donorInputs.currentSdkSha256, 'Original and current D use the same actual pinned SDK bytes');
  const sdkRequire = createRequire(sdk);
  artifacts.native.path = await realpath(sdkRequire.resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'));
  artifacts.native.sha256 = await fileHash(artifacts.native.path);
  assert.match(process.env.LEGACY_NATIVE_CLAUDE_SHA256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(artifacts.native.sha256, process.env.LEGACY_NATIVE_CLAUDE_SHA256);

  const root = await realpath(await mkdtemp(join(tmpdir(), donor ? 'TEST-native-claude-checkpoint-donor-' : 'TEST-native-claude-host-')));
  t.diagnostic(`TEST receipt: ${join(root, 'receipt.json')}`);
  for (const directory of ['home', 'config', 'tmp', 'workspace', 'store', 'xdg-config', 'xdg-data', 'xdg-cache']) await mkdir(join(root, directory), { mode: 0o700 });
  const model = await oracle.startNativeTeamModel({ requireVisibleReply: true, pdfAttachment: true, ...(donor ? { captureHistoryMarkers: true } : {}) });
  let current: ReturnType<typeof startHost> | undefined;
  const hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
  const receipts: Record<string, unknown>[] = [];
  let finalRuntime: Record<string, unknown> = {};
  let launchEvidence: Record<string, unknown> = {};
  let pdfReference: Awaited<ReturnType<typeof uploadNativeMessagePdf>> | undefined;
  let pdfProof: Awaited<ReturnType<typeof readNativeMessagePdf>> | undefined;
  let passed = false;
  let sourceRuntime: Record<string, unknown> | undefined;
  let donorCheckpoint: Awaited<ReturnType<typeof inspectOriginalCheckpoint>> | undefined;
  let oldRestoredHistory = false;
  try {
    const namespace = basename(root);
    const owner = {
      ownerId: `TEST-owner-${namespace}`, revision: 'TEST-revision', storageRoot: join(root, 'store'),
      profileId: `TEST-profile-${namespace}`, protocolVersion: 1 as const, buildId: 'TEST-native-host',
      nodeSha256: artifacts.node.sha256, hostEntrySha256: artifacts.host.entrySha256,
    };
    const scope = { projectId: `TEST-project-${namespace}`, workspaceId: `TEST-workspace-${namespace}`, teamId: 'TEST-team', runId: `TEST-run-${namespace}`, memberId: 'human', generation: '1' };
    const teamBinding = { backendId: owner.ownerId, teamId: scope.teamId, teamName: 'test-native-team' };
    const delivery = { ...teamBinding, runId: scope.runId, memberId: 'alice-id', generation: '1' };
    const profile: TeamHostProfile = {
      schemaVersion: 1, owner, principalId: 'human',
      teams: [{ scope, binding: teamBinding,
        members: [{ memberId: 'alice-id', name: 'alice', role: 'member', delivery }],
        grants: [
          { principalId: 'human', memberName: 'user', permissions: ['read', 'message.write', 'task.write', 'admin'] },
          { principalId: 'alice-session', memberName: 'alice', permissions: ['read', 'message.write', 'task.write'] },
        ],
      }],
      runtime: { members: [{
        teamId: scope.teamId, memberId: 'alice-id', principalId: 'alice-session', provider: 'claude',
        sessionId: `TEST-session-${namespace}`, generation: 1, configRevision: 'TEST-config-1',
        cwd: join(root, 'workspace'), model: 'claude-sonnet-4-6', accountBinding: 'TEST-dummy-account',
        executable: artifacts.native,
        environment: {
          HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'config'), TMPDIR: join(root, 'tmp'),
          XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_DATA_HOME: join(root, 'xdg-data'), XDG_CACHE_HOME: join(root, 'xdg-cache'),
          PATH: `${dirname(node)}:/usr/bin:/bin`, ANTHROPIC_API_KEY: 'TEST-LOCALHOST-ONLY-NOT-A-REAL-KEY', ANTHROPIC_BASE_URL: model.url,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_TELEMETRY: '1', NO_COLOR: '1', TERM: 'dumb',
        },
        nativeTools: ['Bash'], autoAllowedTools: ['Bash'],
        nativeOptions: { projectInstructions: { append: `${CONTEXT_MARKER}. You are alice of test-native-team working only in ${join(root, 'workspace')}.` } },
        limits: { queuedInputs: 2, inputBytes: 8192, outputBytes: 2_000_000, outputEvents: 1500, pendingInteractions: 4, timeoutMs: 45_000 },
      }] },
    };
    const profilePath = join(root, 'profile.json');
    const profileBytes = JSON.stringify(profile);
    await writeFile(profilePath, profileBytes, { mode: 0o600 });
    const binding = { schemaVersion: 1, handleId: `TEST-handle-${namespace}`, owner, scope };
    const envelope = (commandId: string, payload: unknown) => ({ commandId, binding, payload });
    const start = () => helpers.startHost({ node, entry, root, profile: profilePath, profileHash: hash(profileBytes) });
    const command = (label: string) => {
      const commandId = `human-native-${label.toLowerCase()}`;
      return envelope(commandId, { operation: 'message.send', payload: {
        to: 'alice', text: `NATIVE_TEAM_${label}`, messageId: commandId,
        summary: `TEST prepared human message ${label}`, actionMode: 'do',
        ...(label === 'TWO' ? { attachments: [pdfReference!] } : {}),
      } });
    };
    current = start();
    const handshake = await current.rpc('host.handshake', { protocolVersion: 1 });
    assert.ok((handshake.capabilities as string[]).includes('runtime.member-session'));
    const before = await current.rpc('team.launch.read', envelope('TEST-launch-read', {}));
    assert.equal(before.ok, true);
    const original = record(before.value);
    const launchPayload = {
      launchId: original.launchId, rosterRevision: original.rosterRevision,
      configuration: { members: [{ memberId: 'alice-id', model: 'claude-opus-4-6', effort: 'medium', fastMode: false, permissions: 'bypass', context: 'model-default' }] },
    };
    const started = await current.rpc('team.launch.start', envelope('TEST-selected-launch-options', launchPayload));
    assert.equal(started.ok, true, JSON.stringify(started));
    let ready = false;
    const readyDeadline = Date.now() + 45_000;
    while (!ready && Date.now() < readyDeadline) {
      const state: Record<string, unknown> = await current.rpc('runtime.read', envelope('TEST-launch-readiness', { memberId: 'alice-id' }));
      assert.equal(state.ok, true);
      ready = record(state.value).nativeReady === true;
      if (!ready) await tick();
    }
    assert.equal(ready, true, 'actual D native mandatory MCP discovery with prepared options');
    launchEvidence = { originalModel: 'claude-sonnet-4-6', selectedModel: 'claude-opus-4-6', selectedEffort: 'medium', startCommandId: 'TEST-selected-launch-options', launch: started.value };
    pdfReference = await pdf.uploadNativeMessagePdf(current, envelope);
    for (const label of ['ONE', 'TWO']) {
      const receipt: Record<string, unknown> = await current.rpc('team.execute', command(label));
      assert.equal(receipt.ok, true); assert.equal(record(receipt.value).phase, 'completed');
      receipts.push(receipt);
      const inputId = record(record(receipt.value).effects).deliveryId;
      assert.equal(typeof inputId, 'string');
      const deadline = Date.now() + 60_000;
      let terminal = false;
      while (Date.now() < deadline) {
        assert.deepEqual(model.failures, []);
        const read: Record<string, unknown> = await current.rpc('runtime.read', envelope('TEST-read', { memberId: 'alice-id' }));
        assert.equal(read.ok, true);
        finalRuntime = record(read.value);
        const input = (finalRuntime.inputs as unknown[]).map(record).find((item) => item.inputId === inputId);
        if (input?.phase === 'terminal') { assert.equal(input.terminal, 'succeeded'); terminal = true; break; }
        await tick();
      }
      assert.equal(terminal, true, 'bounded native input reaches durable terminal');
      assert.deepEqual(await current.rpc('team.execute', command(label)), receipt);
      assert.equal((await current.rpc('runtime.dispatch', envelope('TEST-resume', { memberId: 'alice-id' }))).ok, true);

      if (donor && label === 'ONE') {
        const settledDeadline = deadline; // The original ONE input budget also bounds this read-only settlement.
        for (;;) {
          const rows = await readdir(join(root, 'store/teams/test-native-team/.host-owner/outbox'));
          assert.ok(rows.length <= 11, 'The finite eleven-request scenario bounds checkpoint outbox reads');
          const outbox = await Promise.all(rows.map(async file => record(JSON.parse(await readFile(join(root, 'store/teams/test-native-team/.host-owner/outbox', file), 'utf8')))));
          if (outbox.every(row => row.phase === 'admitted')) break;
          assert.ok(Date.now() < settledDeadline, 'Original generated notifications settle before checkpoint');
          await tick();
        }
        sourceRuntime = structuredClone(finalRuntime);
        const captured = await current.rpc('runtime.checkpoint', envelope('TEST-capture-original-history', {
          memberId: 'alice-id', checkpointId: 'TEST-history-A', expectedGeneration: sourceRuntime.generation,
        }));
        assert.equal(captured.ok, true); const selected = record(captured.value);
        assert.equal(selected.status, 'published'); assert.equal(typeof selected.reference, 'string');
        assert.match(String(selected.reference), /^cp1-[a-f0-9]{64}$/u);
        const stopped = await current.rpc('runtime.stop', envelope('TEST-stop-original-history', {
          memberId: 'alice-id', expectedGeneration: sourceRuntime.generation,
        }));
        assert.equal(stopped.ok, true); assert.equal(record(stopped.value).custody, 'released');
        await current.close(); hosts.push(current.facts()); current = undefined;
        const count = model.observations.length;
        const selection = Object.fromEntries(Object.entries(launchPayload.configuration.members[0]!).filter(([key]) => key !== 'memberId'));
        donorCheckpoint = await inspectOriginalCheckpoint({
          repo, donor, root, profile, selection, reference: String(selected.reference),
          nativeTools: model.observations[0]!.tools,
        });
        assert.equal(model.observations.length, count, 'Current D refusal performs no inference');
        current = start();
        await current.rpc('host.handshake', { protocolVersion: 1 });
        const restored = await current.rpc('runtime.restore', envelope('TEST-restore-original-history', {
          memberId: 'alice-id', reference: selected.reference, expectedGeneration: sourceRuntime.generation,
        }));
        assert.equal(restored.ok, true);
        const state = record(restored.value);
        assert.equal(state.nativeReady, true); assert.equal(state.attached, true);
        assert.deepEqual(state.inputs, []); assert.notEqual(state.generation, sourceRuntime.generation);
        assert.equal(model.observations.length, count, 'Old owner cold Resume submits no native input');
        await donorCheckpoint.verify();
      }
    }
    pdfProof = await pdf.readNativeMessagePdf(current, envelope, receipts[1]!);
    const pdfObservations = model.observations.filter(item => item.nativePdf !== undefined);
    assert.equal(pdfObservations.length, 1, 'actual native second-DM PDF request observed');
    assert.equal(pdfObservations[0]!.nativePdf!.title, pdfReference.artifactId);
    assert.equal(pdfObservations[0]!.nativePdf!.sha256, pdfProof.sha256);
    assert.equal(pdfObservations[0]!.nativePdf!.byteLength, pdfProof.byteLength);
    const listed = await current.rpc('team.tasks.list', envelope('TEST-list', null));
    assert.equal(listed.ok, true);
    const tasks = listed.value as unknown[];
    assert.equal(tasks.length, 1);
    const task = record(tasks[0]);
    assert.equal(task.status, 'completed'); assert.equal(task.owner, 'alice');
    assert.equal(task.createdBy, 'alice');
    assert.deepEqual((task.historyEvents as unknown[]).map(record).map((item) => item.actor), ['alice', 'alice', 'alice', 'alice']);
    assert.equal((task.comments as unknown[]).length, 1);
    assert.equal(record((task.comments as unknown[])[0]).author, 'alice');
    const inbox = JSON.parse(await readFile(join(root, 'store/teams/test-native-team/inboxes/user.json'), 'utf8')) as unknown[];
    assert.deepEqual(inbox.map(record).map(({ from, text }) => ({ from, text })), [{ from: 'alice', text: 'REPLY_NATIVE_ONE' }, { from: 'alice', text: 'REPLY_NATIVE_TWO' }]);
    assert.equal(new Set(inbox.map(record).map((item) => item.messageId)).size, 2);
    assert.equal(await readFile(join(root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\nTWO\n');
    assert.equal(model.observations.length, 11); assert.deepEqual(model.failures, []);
    assert.ok(model.observations.every((item) => item.contextEffective));
    assert.ok(model.observations.every((item) => item.visibleReplyContract));
    assert.ok(model.observations.every((item) => item.requestedModel === 'claude-opus-4-6'), 'selected model reaches every actual native HTTP request');
    assert.ok(model.observations.every((item) => item.requestedEffort === 'medium'), 'selected effort reaches every actual native HTTP request');
    assert.ok(model.observations.some((item) => item.toolResultError), 'actual native Bash exit seven returns an error tool result before successful conversation completion');
    assert.ok(model.observations.filter((item) => item.turn === 'NATIVE_TEAM_TWO').every((item) => item.priorTurn));
    if (donorCheckpoint) {
      assert.ok(model.observations.filter(item => item.turn === 'NATIVE_TEAM_TWO').every(item =>
        item.priorNativeToolIds?.includes('native_NATIVE_TEAM_ONE_0')), 'Actual cold old-owner TWO contains the original native history');
      await donorCheckpoint.verify(); oldRestoredHistory = true;
    }
    const stopped = await current.rpc('runtime.stop', envelope('TEST-stop', { memberId: 'alice-id' }));
    assert.equal(stopped.ok, true); finalRuntime = record(stopped.value);
    assert.equal(finalRuntime.phase, 'closed'); assert.equal(finalRuntime.custody, 'released');
    await current.close(); hosts.push(current.facts()); current = undefined;
    const requestsBeforeRestart = model.observations.length;
    current = start();
    await current.rpc('host.handshake', { protocolVersion: 1 });
    const replayed = await current.rpc('team.launch.start', envelope('TEST-selected-launch-options', launchPayload));
    assert.equal(replayed.ok, true, 'original configured launch replays after Host restart');
    for (const [index, label] of ['ONE', 'TWO'].entries()) {
      assert.deepEqual(await current.rpc('team.lookup', command(label)), receipts[index]);
      assert.deepEqual(await current.rpc('team.execute', command(label)), receipts[index]);
    }
    const recovered = await current.rpc('runtime.read', envelope('TEST-recovered', { memberId: 'alice-id' }));
    assert.equal(recovered.ok, true); assert.equal(record(recovered.value).attached, false);
    assert.equal((record(recovered.value).inputs as unknown[]).length, donor ? 1 : 2);
    if (donor) assert.equal((sourceRuntime!.inputs as unknown[]).length, 1);
    assert.deepEqual(await pdf.readNativeMessagePdf(current, envelope, receipts[1]!), pdfProof);
    assert.equal((await current.rpc('runtime.dispatch', envelope('TEST-recover-outbox', { memberId: 'alice-id' }))).ok, true);
    await current.close(); hosts.push(current.facts()); current = undefined;
    assert.equal(model.observations.length, requestsBeforeRestart, 'recovered receipts/outbox never launch or resubmit native inputs');
    assert.equal(await readFile(join(root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\nTWO\n');
    if (donor) {
      donorSourceCurrent(donor);
      assert.ok(donorCheckpoint && donorInputs && oldRestoredHistory);
      await donorCheckpoint.verify();
      assert.equal(await treeHash(join(pkg, 'src'), '.ts'), artifacts.host.sourceSha256);
      assert.equal(await treeHash(join(pkg, 'dist'), '.js'), artifacts.host.distSha256);
      assert.equal(await treeHash(join(repo, 'packages/legacy-agent-host/src'), '.ts'), donorInputs.currentHostSourceSha256);
      assert.equal(await treeHash(join(repo, 'packages/legacy-agent-host/dist'), '.js'), donorInputs.currentHostDistSha256);
      assert.equal(await treeHash(await realpath(join(pkg, 'node_modules/@agent-teams/provider-implementations/dist')), '.js'), donorInputs.providerDistSha256);
      assert.equal(await treeHash(await realpath(join(repo, 'packages/legacy-agent-host/node_modules/@agent-teams/provider-implementations/dist')), '.js'), donorInputs.currentProviderDistSha256);
    }
    passed = true;
  } finally {
    let cleanupConfirmed = current === undefined;
    try { if (current) { await current.close(); cleanupConfirmed = true; hosts.push(current.facts()); } }
    finally {
      await model.close();
      await writeFile(join(root, 'receipt.json'), JSON.stringify({
        status: passed ? (donor ? 'CORPUS_QUALIFIED_CURRENT_D_REFUSED' : 'PASS') : 'INCOMPLETE', root, artifacts, hosts,
        ...(donor ? { sourceHead: process.env.OPENCODE_V2_TEST_SOURCE_HEAD, donorInputs, donorCheckpoint: donorCheckpoint?.proof, oldRestoredHistory, originalLocalOutcome: 'unknown-separate-attempt' } : {}),
        cleanupConfirmed, businessReceipts: receipts, runtime: finalRuntime, launchEvidence, pdfProof,
        modelObservations: model.observations, modelFailures: model.failures,
        scope: donor ? 'Genuine exact1d old Host checkpoint, strict current public-D no-allocation refusal, old-owner cold Resume and TWO; no current-Main migration claim' : 'Explicit model/effort launch configuration through standalone Host stdio + RuntimeTeamCoordinator + public D + actual Claude native HTTP/MCP, two rich inputs and canonical replies, restart/replay without new allocation',
        excluded: ['Desktop UI', 'mixed providers', 'whole P4', 'multi-member team/bootstrap', 'real authentication'],
      }, null, 2), { mode: 0o600 });
    }
  }
});
