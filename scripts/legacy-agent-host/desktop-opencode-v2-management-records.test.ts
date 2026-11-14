import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { teamHostProfileSchema } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import { selectOpenCodeV2ManagementModel } from '../../packages/legacy-agent-host/dist/composition/openCodeV2ModelSelection.js';
import { selectRuntimeSourceSeed } from '../../packages/legacy-agent-host/dist/composition/runtimeSourceGrantAuthority.js';
import { storedManagementCommandSchema } from '../../packages/legacy-agent-host/dist/management/commandRecords.js';
import { managementDigest } from '../../packages/legacy-agent-host/dist/management/identity.js';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { assertDesktopV2ManagementSourceHistory, bindDesktopV2ManagementReceipt,
  captureDesktopV2ManagementAuthority, readDesktopV2ManagementPublication } from './desktop-opencode-v2-management-records.ts';
import type { StoredRuntimeSourceCommand } from '../../packages/legacy-agent-host/dist/management/commandRecords.js';
import type { PublishRuntimeSource } from '../../packages/legacy-agent-host/dist/composition/runtimeSourceContracts.js';

async function retainedEvidence() {
  const bytes = await readFile(new URL('./fixtures/c226-opencode-v2-management.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'f3720ccacff5f36965ed38f018da34e6427eac53249e3da7cafc857b9e202ce2');
  const evidence = JSON.parse(bytes.toString('utf8'));
  assert.equal(evidence.provenance.artifactId, 14132244497);
  assert.equal(evidence.provenance.artifactSha256, '0bf8c381830ba401266d2702081e2a0a425e27838ead18b5bbedd34b14d94d44');
  assert.equal(evidence.profile.management[0].embedded.platform, 'linux');
  assert.equal(evidence.profile.management[0].embedded.arch, 'x64');
  return evidence;
}

/** Pure archived-record assertions only: no filesystem or native operation under this tuple. */
function withTuple<T>(platform: 'linux' | 'darwin', arch: 'x64' | 'arm64', work: () => T): T {
  const original = { platform: Object.getOwnPropertyDescriptor(process, 'platform')!,
    arch: Object.getOwnPropertyDescriptor(process, 'arch')! };
  assert.ok(original.platform && original.arch);
  try {
    Object.defineProperties(process, { platform: { ...original.platform, value: platform },
      arch: { ...original.arch, value: arch } });
    return work();
  } finally { Object.defineProperties(process, original); }
}

function decodeRetained(evidence: Awaited<ReturnType<typeof retainedEvidence>>) {
  const profile = teamHostProfileSchema.parse(evidence.profile);
  const commands = evidence.commandFiles.map((file: { name: string; envelope: Record<string, unknown> }) => {
    const { digest, ...body } = file.envelope;
    assert.equal(digest, managementDigest(body));
    const row = storedManagementCommandSchema.parse(body);
    assert.equal(file.name, managementDigest(row.commandId) + '.json'); return row;
  }) as ReturnType<typeof storedManagementCommandSchema.parse>[];
  const publication = commands.find((row): row is StoredRuntimeSourceCommand => row.kind === 'runtime.source')!;
  const command = commands.find(row => row.kind === 'credential.set')!;
  assert.ok(publication && command);
  const authority = captureDesktopV2ManagementAuthority(evidence.root, profile, evidence.descriptor);
  return { evidence, profile, commands, publication, command, authority };
}

async function retained(assertions: (fixture: ReturnType<typeof decodeRetained>) => void) {
  const evidence = await retainedEvidence();
  withTuple('linux', 'x64', () => assertions(decodeRetained(evidence)));
}

test('retained c226 original rejected-key receipt joins its published seed and exact observed native probe', () => retained(({ evidence, profile, commands, publication, command, authority }) => {
  // The old seed-only comparison is the actual recorded CI failure, before any second intent.
  assert.throws(() => assert.equal(command.profileId, profile.management![0]!.profileId));
  const selected = bindDesktopV2ManagementReceipt(authority, commands, command, 'reject-key');
  assert.equal(selected.evidence.commandId, publication.commandId);
  assert.equal(selected.evidence.sourceId, '5d2039fc7d18b20e4ae45268eddb08d91114a10e25fd8f3ad4eda588553c581c');
  assert.equal(selected.evidence.revision, 'b8f6d61925db80b67831f090b33414555515ab550bd85fa958ccd0c3a3d46c80');
  assert.equal(selected.profile.profileId, command.profileId);
  assert.deepEqual(selected.profile.executable, profile.management![0]!.executable);
  assert.deepEqual(selected.profile.environment, profile.management![0]!.environment);
  assert.equal(selected.profile.accountBinding, profile.management![0]!.accountBinding);
  assert.equal(command.kind, 'credential.set'); if (command.kind !== 'credential.set') throw new Error('Original key command missing');
  const nativeProfile = selectOpenCodeV2ManagementModel(selected.profile, {
    providerId: 'test-local', modelId: command.openCodeV2!.verification!.modelId,
  });
  const prefix = 'agent-teams-v2-probe-' + managementDigest({ profile: nativeProfile,
    commandId: command.openCodeV2!.verification!.commandId }).slice(0, 16) + '-';
  assert.ok(basename(evidence.probe.dataRoot).startsWith(prefix));
  assert.equal(prefix, 'agent-teams-v2-probe-c66864101ac6d673-');
}));

test('V2 receipt binding rejects foreign revisions, scope, seed owner, engine and executable', () => retained(({ commands, command, authority }) => {
  for (const field of ['profileId', 'configRevision'] as const)
    assert.throws(() => bindDesktopV2ManagementReceipt(authority, commands,
      { ...command, [field]: 'runtime-source:' + 'f'.repeat(64) }, 'reject-key'));
  assert.throws(() => bindDesktopV2ManagementReceipt(authority, commands, command, 'project-default'));
  for (const mutate of [
    (next: typeof authority) => { next.profile.owner.ownerId = 'TEST-foreign-owner'; },
    (next: typeof authority) => { next.profile.management![0]!.executable.sha256 = 'f'.repeat(64); },
    (next: typeof authority) => {
      const seed = next.profile.management![0]!;
      if (seed.provider !== 'opencode') throw new Error('Expected V2 seed');
      Object.defineProperty(seed, 'protocolRevision', { value: 'TEST-foreign-version' });
    },
  ]) {
    const changed = structuredClone(authority); mutate(changed);
    assert.throws(() => bindDesktopV2ManagementReceipt(changed, commands, command, 'reject-key'));
  }
}));

test('V2 publication rejects an internally rehashed foreign descriptor grant or replacement executable', () => retained(({ publication, authority }) => {
  for (const mutate of [
    (input: PublishRuntimeSource) => { input.grant.ownerId = 'TEST-foreign-owner'; },
    (input: PublishRuntimeSource) => { input.grant.contextId = 'TEST-foreign-context'; },
    (input: PublishRuntimeSource) => { input.candidate.executable.sha256 = 'f'.repeat(64); },
  ]) {
    const input = JSON.parse(publication.publicationJson!); mutate(input);
    const changed = { ...publication, fingerprint: runtimeDigest(input), publicationJson: JSON.stringify(input),
      selectionDigest: runtimeDigest({ grant: input.grant, seed: authority.profile.management![0] }),
      revision: runtimeDigest({ previousRevision: input.expectedRevision, commandId: input.commandId,
        grant: input.grant, candidate: input.candidate, intent: input.intent }) };
    assert.throws(() => readDesktopV2ManagementPublication(authority, changed));
  }
}));

test('V2 source history accounts for every publication and the exact retained current chain', () => retained(({ publication, authority, commands, command }) => {
  const input = JSON.parse(publication.publicationJson!);
  const body = { schemaVersion: 1, records: [{ previousRevision: input.expectedRevision,
    commandId: input.commandId, grant: input.grant, candidate: input.candidate, intent: input.intent,
    revision: publication.revision }], current: [{ sourceId: publication.sourceId,
    revision: publication.revision, commandId: publication.commandId }] };
  const index = { ...body, digest: runtimeDigest(body) };
  assert.equal(assertDesktopV2ManagementSourceHistory(authority, commands, index).length, 1);
  assert.throws(() => assertDesktopV2ManagementSourceHistory(authority, [command], index));
  assert.throws(() => assertDesktopV2ManagementSourceHistory(authority, [...commands, publication], index));
  assert.throws(() => assertDesktopV2ManagementSourceHistory(authority,
    commands.map(row => row.kind === 'runtime.source' ? { ...row, phase: 'held' } : row), index));
  const rewritten = structuredClone(body); rewritten.current[0]!.revision = 'f'.repeat(64);
  assert.throws(() => assertDesktopV2ManagementSourceHistory(authority, commands,
    { ...rewritten, digest: runtimeDigest(rewritten) }));
  assert.throws(() => assertDesktopV2ManagementSourceHistory(authority, commands,
    { ...index, digest: 'f'.repeat(64) }));
}));

test('original Host rejects old other-project cwd and accepts only its separate exact private-account seed', () => retained(({ authority, evidence, profile }) => {
  const foreignCwd = authority.grants.find(row => row.projectPath === join(evidence.root, 'workspace-other'))!;
  assert.throws(() => selectRuntimeSourceSeed(profile, foreignCwd));
  const other = { ...structuredClone(profile.management![0]!), profileId: 'TEST-v2-settings-management-other',
    cwd: join(evidence.root, 'workspace-other') };
  profile.management!.push(other); evidence.descriptor.management[2].profileId = other.profileId;
  const corrected = captureDesktopV2ManagementAuthority(evidence.root, profile, evidence.descriptor);
  assert.deepEqual(corrected.grants.map(grant => selectRuntimeSourceSeed(profile, grant).profileId),
    [profile.management![0]!.profileId, profile.management![0]!.profileId, other.profileId]);
  assert.deepEqual(other.environment, profile.management![0]!.environment);
  assert.deepEqual(other.executable, profile.management![0]!.executable);
  assert.equal(other.accountBinding, profile.management![0]!.accountBinding);
}));

test('archived V2 tuple isolation restores the real runner and preserves foreign-platform refusal', async () => {
  const evidence = await retainedEvidence();
  const original = () => ({ platform: Object.getOwnPropertyDescriptor(process, 'platform'),
    arch: Object.getOwnPropertyDescriptor(process, 'arch') });
  const before = original();
  const refused = () => {
    const result = teamHostProfileSchema.safeParse(evidence.profile);
    assert.equal(result.success, false);
    if (result.success) assert.fail('Foreign archived tuple must remain inadmissible');
    assert.ok(result.error.issues.some(issue => issue.message === 'OpenCode V2 delivery must match the native platform' &&
      JSON.stringify(issue.path) === JSON.stringify(['management', 0, 'embedded'])));
  };
  if (process.platform !== 'linux' || process.arch !== 'x64') refused();
  withTuple('darwin', 'arm64', refused);
  withTuple('linux', 'arm64', refused);
  assert.deepEqual(original(), before);
  const failure = new Error('TEST pure archived assertion failure');
  assert.throws(() => withTuple('linux', 'x64', () => {
    assert.equal(teamHostProfileSchema.safeParse(evidence.profile).success, true);
    throw failure;
  }), error => error === failure);
  assert.deepEqual(original(), before, 'failed assertions also restore exact original property descriptors');
});
