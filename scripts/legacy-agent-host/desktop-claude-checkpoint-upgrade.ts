import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, lstatSync } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { normalizeBinding, runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { treeHash } from '../../packages/legacy-agent-host/tests/fixtures/native-host.ts';
import { readNativeProviderArtifact, verifyNativeProviderArtifact } from '../../packages/legacy-agent-host/tests/fixtures/native-provider-artifact.ts';
import type { checkpoint } from './desktop-resume-records.ts';
import type { RuntimeBinding } from '../../packages/legacy-agent-host/dist/runtime/contracts.js';
import type { TeamLaunchRecord } from '../../packages/legacy-agent-host/dist/team-launch/contracts.js';

type Fixture = Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
type Evidence = Record<string, unknown>;
type FileEvidence = { path: string; cap: number; size: number; sha256: string; bytes?: Buffer };
const DONOR = '1d0f97f55de566036c970eab4f36b84620afdb3f';
const OLD_ARCHIVE = 'vendor/provider-migration/opencode-v2-host-9ede557c/agent-teams-provider-implementations-0.0.0.tgz';
const OLD_SHA = 'fc8a821aff5b96b649647dac3853c831acf83d1555a480dc1f9645006600cb89';
const CONTRACTS_SHA = 'aaf9506473f6a2868a375a6087e1b4edc561b38f34101ef7a8703a73bb2674db';
const NATIVE_SHA = 'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f';
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const assertSame = (actual: unknown, expected: unknown, message = 'original captured values differ') =>
  assert.equal(isDeepStrictEqual(actual, expected), true, message);
const object = (value: unknown): Evidence => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Evidence;
};

/** Fixed original files only: retained FD, bounded positional reads and a full before/after identity. */
async function capturedFile(path: string, cap: number, retain = false): Promise<FileEvidence> {
  assert.equal(await realpath(path), path);
  const before = await lstat(path, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size > 0n && before.size <= BigInt(cap));
  const same = (value: typeof before) => {
    assert.ok(value.isFile() && !value.isSymbolicLink());
    for (const key of ['dev', 'ino', 'size', 'mode', 'nlink', 'uid', 'mtimeNs', 'ctimeNs'] as const)
      assert.equal(value[key], before[key], 'original file changed during its bounded read');
  };
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    same(await file.stat({ bigint: true }));
    const size = Number(before.size), digest = createHash('sha256');
    const chunk = Buffer.alloc(Math.min(size, 64 * 1024));
    const retained = retain ? Buffer.alloc(size) : undefined;
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
      assert.ok(bytesRead > 0);
      digest.update(chunk.subarray(0, bytesRead));
      if (retained) chunk.copy(retained, offset, 0, bytesRead);
      offset += bytesRead;
    }
    assert.equal((await file.read(Buffer.alloc(1), 0, 1, size)).bytesRead, 0);
    same(await file.stat({ bigint: true }));
    same(await lstat(path, { bigint: true }));
    assert.equal(await realpath(path), path);
    return { path, cap, size, sha256: digest.digest('hex'), ...(retained ? { bytes: retained } : {}) };
  } finally { await file.close(); }
}
async function jsonFile(path: string, cap: number) {
  const captured = await capturedFile(path, cap, true);
  return { ...captured, value: object(JSON.parse(captured.bytes!.toString('utf8'))) };
}
function donorCurrent(repo: string): void {
  const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args],
    { encoding: 'utf8', timeout: 3000, maxBuffer: 256 * 1024 }).trim();
  assert.equal(git(['rev-parse', 'HEAD']), DONOR);
  assert.equal(git(['status', '--porcelain=v1', '--untracked-files=no']), '');
}
function runtimePath(root: string, raw: unknown): string {
  const binding = normalizeBinding(raw as RuntimeBinding);
  return join(root, 'hoststore/runtime-sessions', runtimeDigest({
    backendId: binding.backendId, teamId: binding.teamId, memberId: binding.memberId,
  }), runtimeDigest(binding) + '.json');
}
async function unchanged(file: FileEvidence): Promise<void> {
  const current = await capturedFile(file.path, file.cap);
  assert.equal(current.size, file.size);
  assert.equal(current.sha256, file.sha256, 'original retained file bytes remain unchanged');
}

export interface DesktopClaudeCheckpointUpgrade {
  readonly kind: 'same-owner-claude-checkpoint';
  readonly original: Fixture;
  readonly successor: Fixture;
  readonly proof: Evidence;
  beforeQuit(source: Evidence, checkpointValue: Awaited<ReturnType<typeof checkpoint>>): Promise<void>;
  afterOriginalQuit(): Promise<Fixture>;
  afterColdDiscovery(): Promise<void>;
  finish(): Promise<void>;
}

/** One fresh Desktop producer/consumer pair. It never imports the standalone corpus or opens a provider. */
export async function prepareDesktopClaudeCheckpointUpgrade(repo: string, pnpm: string, modelUrl: string) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.equal(process.version, 'v24.21.0');
  const donor = await realpath(process.env.LEGACY_DESKTOP_CLAUDE_CHECKPOINT_DONOR!);
  assert.equal(donor, join(repo, '.stage1-checkpoint-donor'));
  donorCurrent(donor);
  const oldHost = join(donor, 'packages/legacy-agent-host');
  const currentHost = join(repo, 'packages/legacy-agent-host');
  const node = await realpath(join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node'));
  assert.equal(await realpath(process.execPath), node);
  const oldEntry = await capturedFile(await realpath(join(oldHost, 'dist/cli.js')), 2 * 1024 * 1024, true);
  const currentEntry = await capturedFile(await realpath(join(currentHost, 'dist/cli.js')), 2 * 1024 * 1024, true);
  assert.notEqual(oldEntry.path, currentEntry.path);
  assertSame(oldEntry.bytes, currentEntry.bytes, 'naturally compiled entry equality before any app effect');
  assert.equal(oldEntry.sha256, currentEntry.sha256);
  const selectedNode = await capturedFile(node, 512 * 1024 * 1024);
  const sourceInputs = async () => ({
    originalSource: await treeHash(join(oldHost, 'src'), '.ts'),
    originalDist: await treeHash(join(oldHost, 'dist'), '.js'),
    currentSource: await treeHash(join(currentHost, 'src'), '.ts'),
    currentDist: await treeHash(join(currentHost, 'dist'), '.js'),
  });
  const sources = await sourceInputs();
  assert.notEqual(sources.originalSource, sources.currentSource);
  assert.notEqual(sources.originalDist, sources.currentDist);
  const originalPackage = await jsonFile(join(oldHost, 'package.json'), 256 * 1024);
  assert.equal(object(originalPackage.value.dependencies)['@agent-teams/provider-implementations'],
    'file:../../' + OLD_ARCHIVE);
  await verifyNativeProviderArtifact(donor, { path: OLD_ARCHIVE, sha256: OLD_SHA });
  const currentArchive = await readNativeProviderArtifact(repo);
  await verifyNativeProviderArtifact(repo, currentArchive);
  const archive = await capturedFile(join(donor, OLD_ARCHIVE), 64 * 1024 * 1024);
  assert.equal(archive.sha256, OLD_SHA);
  const contracts = await capturedFile(join(donor, dirname(OLD_ARCHIVE),
    'agent-teams-provider-session-contracts-0.0.0.tgz'), 16 * 1024 * 1024);
  assert.equal(contracts.sha256, CONTRACTS_SHA);
  const currentArchiveFile = await capturedFile(join(repo, currentArchive.path), 64 * 1024 * 1024);
  assert.equal(currentArchiveFile.sha256, currentArchive.sha256);
  const originalProvider = await realpath(join(oldHost, 'node_modules/@agent-teams/provider-implementations'));
  const currentProvider = await realpath(join(currentHost, 'node_modules/@agent-teams/provider-implementations'));
  const sdk = await realpath(createRequire(join(originalProvider, 'dist/claude.js')).resolve('@anthropic-ai/claude-agent-sdk'));
  const currentSdk = await realpath(createRequire(join(currentProvider, 'dist/claude.js')).resolve('@anthropic-ai/claude-agent-sdk'));
  const sdkPackage = await jsonFile(join(dirname(sdk), 'package.json'), 256 * 1024);
  const currentSdkPackage = await jsonFile(join(dirname(currentSdk), 'package.json'), 256 * 1024);
  assert.equal(sdkPackage.value.version, '0.3.305');
  assert.equal(currentSdkPackage.value.version, '0.3.305');
  const originalSdk = await capturedFile(sdk, 16 * 1024 * 1024);
  const selectedSdk = await capturedFile(currentSdk, 16 * 1024 * 1024);
  assert.equal(originalSdk.sha256, selectedSdk.sha256);
  // This is the original SDK's default package resolver, not PATH or the current CLI override.
  const nativePath = await realpath(createRequire(sdk).resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'));
  const native = await capturedFile(nativePath, 512 * 1024 * 1024);
  assert.equal(native.sha256, NATIVE_SHA);
  const dependencyInputs = async () => ({
    originalLock: (await capturedFile(join(donor, 'pnpm-lock.yaml'), 8 * 1024 * 1024)).sha256,
    originalProviderDist: await treeHash(join(originalProvider, 'dist'), '.js'),
    currentProviderDist: await treeHash(join(currentProvider, 'dist'), '.js'),
  });
  const dependencies = await dependencyInputs();
  const original = await prepareDesktopBackendFixture(repo, {
    pnpmEntry: pnpm, launchDialog: true, seedUiTask: true,
    claudeCheckpointDonor: { repo: donor, hostEntrySha256: oldEntry.sha256 },
    nativeClaude: { path: nativePath, sha256: native.sha256, modelUrl },
  });
  assert.equal(original.node, node);
  assert.equal(original.hostEntry, oldEntry.path);
  assert.equal(original.pins.nodeSha256, selectedNode.sha256);
  assert.equal(original.pins.hostEntrySha256, currentEntry.sha256);
  const profileFile = await jsonFile(original.profilePath, 256 * 1024);
  assert.equal(profileFile.sha256, original.pins.profileSha256);
  const oldRead = await import(pathToFileURL(join(oldHost, 'dist/composition/readProfile.js')).href) as {
    readTeamHostProfile: typeof readTeamHostProfile;
  };
  const oldProfile = oldRead.readTeamHostProfile(original.profilePath, profileFile.sha256);
  const currentProfile = readTeamHostProfile(original.profilePath, profileFile.sha256);
  assertSame(oldProfile, currentProfile, 'both actual validators accept the unchanged full profile');
  assert.equal(oldProfile.owner.nodeSha256, selectedNode.sha256);
  assert.equal(oldProfile.owner.hostEntrySha256, oldEntry.sha256);
  assert.equal(currentProfile.owner.hostEntrySha256, currentEntry.sha256);
  assert.equal(currentProfile.runtime?.members.length, 1);
  const seed = oldProfile.runtime!.members[0]!;
  assert.equal(seed.provider, 'claude');
  assertSame(seed.executable, { path: nativePath, sha256: native.sha256 });
  const descriptorFile = await jsonFile(original.descriptorPath, 256 * 1024);
  assert.equal(descriptorFile.sha256, original.pins.descriptorSha256);
  const descriptor = descriptorFile.value;
  assert.ok(Array.isArray(descriptor.owners) && descriptor.owners.length === 1);
  const capturedOwner = object(descriptor.owners[0]), capturedProfile = object(capturedOwner.profile);
  assert.equal(capturedProfile.hostEntry, oldEntry.path);
  assert.equal(capturedProfile.nodeExecutable, node);
  assert.equal(capturedProfile.nodeVersion, process.version);
  assert.equal(capturedProfile.hostEntrySha256, currentEntry.sha256);
  assert.equal(capturedProfile.expectedBuildId, currentProfile.owner.buildId);
  const nextDescriptor = structuredClone(descriptor);
  object(object((nextDescriptor.owners as unknown[])[0]).profile).hostEntry = currentEntry.path;
  const descriptorPath = join(original.root, 'desktop-checkpoint-successor-descriptor.json');
  const nextBytes = JSON.stringify(nextDescriptor);
  await writeFile(descriptorPath, nextBytes, { mode: 0o600, flag: 'wx' });
  const successorDescriptor = await capturedFile(descriptorPath, 256 * 1024);
  assert.equal(successorDescriptor.sha256, hash(nextBytes));
  const successor: Fixture = {
    ...original, hostEntry: currentEntry.path, descriptorPath,
    pins: { ...original.pins, descriptorSha256: successorDescriptor.sha256 },
    appEnvironment: { ...original.appEnvironment,
      AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH: descriptorPath,
      AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256: successorDescriptor.sha256 },
  };
  const pins = [selectedNode, oldEntry, currentEntry, archive, contracts, currentArchiveFile,
    sdkPackage, currentSdkPackage, originalSdk, selectedSdk, native, originalPackage,
    profileFile, descriptorFile, successorDescriptor];
  const frozenInputs = async () => {
    donorCurrent(donor);
    for (const pin of pins) await unchanged(pin);
    assertSame(await sourceInputs(), sources);
    assertSame(await dependencyInputs(), dependencies);
  };
  const proof: Evidence = {
    schemaVersion: 1, status: 'INCOMPLETE',
    scope: 'Genuine exact1d Host checkpoint consumed through current Main and current Host with natural whole-owner equality',
    donorCommit: DONOR, sdkVersion: '0.3.305', sources, dependencies,
    originalArchiveSha256: archive.sha256, currentArchiveSha256: currentArchiveFile.sha256,
    contractsSha256: contracts.sha256, sdkSha256: originalSdk.sha256, nativeSha256: native.sha256,
    nodeVersion: process.version, nodeSha256: selectedNode.sha256,
    originalEntrySha256: oldEntry.sha256, currentEntrySha256: currentEntry.sha256,
    naturalEntryBytesEqual: true, profileSha256: profileFile.sha256,
    originalDescriptorSha256: descriptorFile.sha256, successorDescriptorSha256: successorDescriptor.sha256,
    originalOwner: oldProfile.owner, successorOwner: currentProfile.owner,
    excluded: ['old Main executable migration', 'standalone corpus transplantation', 'rewritten checkpoint', 'vendor inference'],
  };
  const handlePath = join(original.root, 'userData/agent-backend/bindings', hash(original.handleId) + '.json');
  let captured: {
    source: FileEvidence; checkpoint: FileEvidence; history: FileEvidence; launch: FileEvidence;
    handle: FileEvidence; payload: Evidence; sourceRecord: Evidence; launchPath: string;
  } | undefined;
  let quitVerified = false, coldVerified = false;
  const handle = async () => {
    const row = await jsonFile(handlePath, 16 * 1024);
    assertSame(Object.keys(row.value).sort(), ['handleId', 'owner', 'schemaVersion', 'scope']);
    assert.equal(row.value.schemaVersion, 1); assert.equal(row.value.handleId, original.handleId);
    assertSame(row.value.owner, oldProfile.owner);
    assertSame(row.value.owner, currentProfile.owner);
    assertSame(row.value.scope, currentProfile.teams[0]!.scope);
    return row;
  };
  const sourceUnchanged = async (includeLaunch: boolean) => {
    assert.ok(captured);
    for (const row of [captured.source, captured.checkpoint, captured.handle,
      ...(includeLaunch ? [captured.history, captured.launch] : [])]) await unchanged(row);
    const stored = await handle(); assert.equal(stored.sha256, captured.handle.sha256);
  };
  const upgrade: DesktopClaudeCheckpointUpgrade = {
    kind: 'same-owner-claude-checkpoint', original, successor, proof,
    async beforeQuit(source, checkpoint) {
      assert.equal(captured, undefined);
      assert.equal(source.phase, 'closed'); assert.equal(source.custody, 'released');
      const sourceFile = await jsonFile(runtimePath(original.root, source.binding), 16 * 1024 * 1024);
      assertSame(sourceFile.value, source);
      const checkpointFile = await jsonFile(checkpoint.path, 8 * 1024 * 1024);
      assert.equal(checkpointFile.sha256, checkpoint.payloadFileSha256);
      assertSame(checkpointFile.value, checkpoint.payload);
      const opaque = object(checkpointFile.value.opaque);
      assert.equal(opaque.version, 1); assert.equal(opaque.engine, '0.3.305');
      assert.equal(opaque.nativeSession, checkpoint.nativeSession);
      assert.match(String(opaque.compatibility), /^[a-f0-9]{64}$/);
      const history = await capturedFile(checkpoint.historyPath, 64 * 1024 * 1024, true);
      assert.equal(history.sha256, checkpoint.historySha256);
      const sourceBinding = normalizeBinding(source.binding as RuntimeBinding);
      assert.equal(sourceBinding.backendId, oldProfile.owner.ownerId);
      assert.equal(sourceBinding.teamId, oldProfile.teams[0]!.binding.teamId);
      assert.equal(sourceBinding.memberId, seed.memberId);
      const launchPath = join(original.root, 'hoststore/teams', oldProfile.teams[0]!.binding.teamName,
        '.host-owner/launches', runtimeDigest(sourceBinding.runId) + '.json');
      const launch = await jsonFile(launchPath, 1024 * 1024);
      const journal = launch.value as unknown as TeamLaunchRecord;
      const { validateLaunchRecord } = await import(pathToFileURL(join(oldHost, 'dist/team-launch/validateLaunchRecord.js')).href) as
        typeof import('../../packages/legacy-agent-host/dist/team-launch/validateLaunchRecord.js');
      validateLaunchRecord(journal, journal.fingerprint, journal.definition.members.length);
      assert.equal(journal.definition.members.length, 1);
      assertSame(journal.definition.rosterScope, oldProfile.teams[0]!.scope);
      let base: NonNullable<typeof oldProfile.runtime>['members'][number] = seed;
      if (journal.definition.capture !== undefined) {
        const { runtimeCaptureSourceSchema, compileRuntimeCapture } = await import(
          pathToFileURL(join(oldHost, 'dist/composition/runtimeCaptureSource.js')).href
        ) as typeof import('../../packages/legacy-agent-host/dist/composition/runtimeCaptureSource.js');
        const originalCapture = runtimeCaptureSourceSchema.parse(journal.definition.capture);
        assert.equal(originalCapture.members.length, 1);
        assert.equal(originalCapture.members[0]!.memberId, seed.memberId);
        assert.equal(originalCapture.members[0]!.role, 'lead');
        assert.ok(originalCapture.mcpRecipeReferences);
        assert.equal(originalCapture.mcpRecipeReferences.length, 1);
        assert.equal(originalCapture.mcpRecipeReferences[0]!.memberId, seed.memberId);
        assert.equal(dirname(dirname(launchPath)), join(oldProfile.owner.storageRoot, 'teams',
          oldProfile.teams[0]!.binding.teamName, '.host-owner'));
        // The old store constructor can create absent parents. Require the complete
        // original namespace synchronously before its metadata-only reconstruction.
        for (let path = join(dirname(launchPath), 'mcp-recipes'); ; path = dirname(path)) {
          const stat = lstatSync(path);
          assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
          if (path === dirname(path)) break;
        }
        const compiled = compileRuntimeCapture(oldProfile,
          { definition: oldProfile.teams[0]! }, originalCapture);
        assert.equal(compiled.registration.launchId, journal.definition.launchId);
        assert.equal(compiled.registration.launchId, sourceBinding.runId);
        assert.equal(compiled.registration.commandId, originalCapture.commandId);
        assert.equal(compiled.registration.expectedRevision, originalCapture.configurationRevision);
        assert.equal(compiled.registration.members.length, 1);
        assertSame(normalizeBinding(compiled.registration.members[0]!.delivery), sourceBinding);
        assert.equal(compiled.profiles.length, 1);
        base = compiled.profiles[0]!;
        assert.equal(base.memberId, seed.memberId);
        assert.equal(base.teamId, seed.teamId);
        assert.equal(base.provider, seed.provider);
        assertSame(base.executable, seed.executable);
      }
      const selected = journal.definition.members.filter(row => row.memberId === base.memberId);
      const attempts = journal.members.filter(row => row.memberId === base.memberId);
      assert.equal(selected.length, 1); assert.equal(attempts.length, 1);
      assertSame(selected[0]!.binding, sourceBinding);
      assert.equal(selected[0]!.baseConfigurationDigest, runtimeDigest(base));
      const currentAttempt = attempts[0]!.attempts.at(-1)!;
      assert.equal(currentAttempt.attemptId, attempts[0]!.currentAttemptId);
      assert.equal(currentAttempt.claimed, true); assert.equal(currentAttempt.noAllocation, false);
      assert.equal(currentAttempt.hostIncarnation, source.hostIncarnation);
      let configured: NonNullable<typeof oldProfile.runtime>['members'][number] = base;
      if (journal.preparation !== undefined) {
        const prepared = journal.preparation.members.filter(row => row.memberId === base.memberId);
        assert.equal(prepared.length, 1);
        const { applyLaunchConfiguration } = await import(pathToFileURL(join(oldHost, 'dist/composition/launchConfiguration.js')).href) as
          typeof import('../../packages/legacy-agent-host/dist/composition/launchConfiguration.js');
        configured = applyLaunchConfiguration(base, prepared[0]!.configuration);
      }
      const effective = { ...configured,
        generation: selected[0]!.runtimeGeneration! };
      assert.equal(runtimeDigest(effective), selected[0]!.configurationDigest);
      assert.equal(effective.generation, object(source.config).generation);
      assert.equal(effective.configRevision, object(source.config).configRevision);
      assert.equal(effective.sessionId, object(source.config).sessionId);
      const stored = await handle();
      captured = { source: sourceFile, checkpoint: checkpointFile, history, launch, handle: stored,
        payload: checkpointFile.value, sourceRecord: source, launchPath };
      const folder = join(original.root, 'claude-checkpoint-upgrade');
      await mkdir(folder, { mode: 0o700 });
      for (const [name, row] of [['launch', launch], ['runtime', sourceFile], ['checkpoint', checkpointFile],
        ['handle', stored], ['native-prefix', history]] as const)
        await writeFile(join(folder, name + (name === 'native-prefix' ? '.jsonl' : '.json')), row.bytes!,
          { mode: 0o600, flag: 'wx' });
      proof.original = { sourceBinding, attemptId: currentAttempt.attemptId,
        originalHostIncarnation: currentAttempt.hostIncarnation, reference: checkpointFile.value.reference,
        nativeSession: opaque.nativeSession, compatibility: opaque.compatibility,
        baseConfigurationDigest: selected[0]!.baseConfigurationDigest,
        configurationDigest: selected[0]!.configurationDigest,
        runtimeSha256: sourceFile.sha256, launchSha256: launch.sha256, checkpointSha256: checkpointFile.sha256,
        nativePrefixSha256: history.sha256, nativePrefixBytes: history.size, persistedHandleSha256: stored.sha256 };
      await frozenInputs();
    },
    async afterOriginalQuit() {
      assert.ok(captured); assert.equal(quitVerified, false);
      await sourceUnchanged(true); await frozenInputs();
      quitVerified = true; proof.originalBytesAfterQuit = true;
      return successor;
    },
    async afterColdDiscovery() {
      assert.equal(quitVerified, true); assert.equal(coldVerified, false);
      await sourceUnchanged(true); await frozenInputs();
      coldVerified = true; proof.unchangedStoredHandleAfterCold = true;
    },
    async finish() {
      assert.ok(captured); assert.equal(coldVerified, true);
      await sourceUnchanged(false);
      const launch = await jsonFile(captured.launchPath, 1024 * 1024);
      const journal = launch.value as unknown as TeamLaunchRecord;
      const selected = journal.definition.members.filter(row => row.memberId === seed.memberId);
      assert.equal(selected.length, 1);
      const target = selected[0]!;
      assert.ok(target.restore && target.binding);
      assert.equal(target.restore.reference, captured.payload.reference);
      assertSame(target.restore.sourceBinding, captured.sourceRecord.binding);
      const runtime = await jsonFile(runtimePath(original.root, target.binding), 16 * 1024 * 1024);
      assert.equal(runtime.value.phase, 'closed'); assert.equal(runtime.value.custody, 'released');
      assertSame(object(runtime.value.restoredFrom).sourceBinding, captured.sourceRecord.binding);
      assert.equal(object(runtime.value.restoredFrom).reference, captured.payload.reference);
      assert.equal(object(runtime.value.config).checkpointRef, captured.payload.reference);
      assert.notEqual(runtime.value.hostIncarnation, captured.sourceRecord.hostIncarnation);
      assert.equal(runtime.value.sessionRef, captured.sourceRecord.sessionRef);
      assert.ok(Array.isArray(runtime.value.inputs) && runtime.value.inputs.length === 1);
      assert.ok(Array.isArray(captured.sourceRecord.inputs) && captured.sourceRecord.inputs.length === 1);
      const completed = object(runtime.value.inputs[0]); assert.equal(completed.phase, 'terminal');
      assert.equal(completed.terminal, 'succeeded');
      const checkpoints = (runtime.value.checkpoints as unknown[]).map(object).filter(row => row.status === 'published');
      assert.equal(checkpoints.length, 1);
      assert.match(String(checkpoints[0]!.reference), /^cp1-[a-f0-9]{64}$/);
      const next = await jsonFile(join(original.root, 'hoststore/runtime-checkpoints',
        String(checkpoints[0]!.reference) + '.json'), 8 * 1024 * 1024);
      const { digest, ...body } = next.value;
      assert.equal(runtimeDigest(body), digest);
      assert.equal(digest, checkpoints[0]!.payloadDigest);
      assert.equal(next.value.reference, checkpoints[0]!.reference);
      assert.equal(next.value.historyDigest, checkpoints[0]!.historyDigest);
      const operations = [{ inputId: object(completed.intent).inputId,
        operationRef: completed.operationRef, fingerprint: completed.fingerprint, outcome: completed.terminal }];
      assertSame(next.value.completedOperations, operations);
      assert.equal(next.value.historyDigest, runtimeDigest({
        baseline: object(runtime.value.config).checkpointRef ?? null, operations }));
      assert.equal(next.value.reference, 'cp1-' + runtimeDigest({
        binding: runtime.value.binding, checkpointId: next.value.checkpointId }));
      assertSame(next.value.sourceBinding, runtime.value.binding);
      assertSame(next.value.sourceConfig, runtime.value.config);
      assert.equal(next.value.sourceSessionRef, runtime.value.sessionRef);
      const nextOpaque = object(next.value.opaque), oldOpaque = object(captured.payload.opaque);
      assert.equal(nextOpaque.engine, '0.3.305'); assert.equal(nextOpaque.version, 1);
      assert.equal(nextOpaque.nativeSession, oldOpaque.nativeSession);
      assert.match(String(nextOpaque.compatibility), /^[a-f0-9]{64}$/);
      assert.notEqual(nextOpaque.compatibility, oldOpaque.compatibility, 'the new checkpoint uses normal current compatibility');
      const history = await capturedFile(captured.history.path, 64 * 1024 * 1024, true);
      assert.ok(history.size > captured.history.size);
      assertSame(history.bytes!.subarray(0, captured.history.size), captured.history.bytes);
      await frozenInputs();
      proof.current = { sourceBinding: runtime.value.binding, reference: next.value.reference,
        originalReference: captured.payload.reference, nativeSession: nextOpaque.nativeSession,
        compatibility: nextOpaque.compatibility, checkpointSha256: next.sha256,
        originalPrefixRetained: true, originalCheckpointUnchanged: true,
        samePersistedHandle: true, inputs: 2 };
      proof.status = 'PASS';
    },
  };
  await frozenInputs();
  return Object.assign(original, { claudeCheckpointUpgrade: upgrade });
}
