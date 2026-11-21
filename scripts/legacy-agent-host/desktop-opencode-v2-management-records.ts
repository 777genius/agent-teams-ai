import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { runtimeSourceRecordSchema } from '../../packages/legacy-agent-host/dist/adapters/profile/FileRuntimeSourceIndex.js';
import { captureOpenCodeConfigurationSource } from '../../packages/legacy-agent-host/dist/adapters/providers/OpenCodeConfigurationSource.js';
import { applyOpenCodeRuntimeSource } from '../../packages/legacy-agent-host/dist/composition/applyOpenCodeRuntimeSource.js';
import { runtimeSourceGrantSchema } from '../../packages/legacy-agent-host/dist/composition/runtimeSourceContracts.js';
import { readOriginalRuntimeSourcePublication, selectRuntimeSourceSeed, validateRuntimeSourceHistory } from '../../packages/legacy-agent-host/dist/composition/runtimeSourceGrantAuthority.js';
import { storedManagementCommandSchema } from '../../packages/legacy-agent-host/dist/management/commandRecords.js';
import { managementDigest } from '../../packages/legacy-agent-host/dist/management/identity.js';
import { openCodeManagementProfileSchema } from '../../packages/legacy-agent-host/dist/management/profile.js';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import type { StoredManagementCommand, StoredRuntimeSourceCommand } from '../../packages/legacy-agent-host/dist/management/commandRecords.js';
import type { DesktopV2ManagementStep } from './desktop-opencode-v2-management-model.ts';

type Row = Record<string, unknown>;
const object = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Row;
};
const array = (value: unknown): Row[] => { assert.ok(Array.isArray(value)); return value.map(object); };

/** Exact descriptor normalization used by Main's capturedRuntimeSourceGrant, without starting Main. */
export function captureDesktopV2ManagementAuthority(root: string, profile: TeamHostProfile, raw: unknown) {
  const descriptor = object(raw), owners = array(descriptor.owners), handles = array(descriptor.handles);
  assert.equal(descriptor.schemaVersion, 1); assert.equal(owners.length, 1); assert.equal(profile.runtime, undefined);
  const owner = owners[0]!, ownerRef = { ownerId: profile.owner.ownerId, revision: profile.owner.revision };
  assert.equal(owner.ownerId, ownerRef.ownerId); assert.equal(owner.revision, ownerRef.revision);
  assert.equal(owner.storageRoot, join(root, 'hoststore'));
  assert.equal(object(owner.profile).profileId, profile.owner.profileId);
  assert.equal(object(owner.profile).nodeSha256, profile.owner.nodeSha256);
  assert.equal(object(owner.profile).hostEntrySha256, profile.owner.hostEntrySha256);
  const normalizedOwner = { ownerId: owner.ownerId, revision: owner.revision,
    storageRoot: owner.storageRoot, profile: owner.profile };
  const selections = array(descriptor.management);
  assert.deepEqual(selections.map(row => row.projectPath), [null, join(root, 'workspace'), join(root, 'workspace-other')]);
  const grants = selections.map(row => {
    assert.equal(row.runtimeId, 'opencode'); assert.equal(row.contextId, 'local'); assert.deepEqual(row.owner, ownerRef);
    const preferences = object(row.preferences);
    assert.equal(preferences.globalRoot, join(root, 'preferences/global'));
    assert.equal(preferences.projectRoot, row.projectPath === null ? null : join(root, 'preferences', basename(String(row.projectPath))));
    const selected = { runtimeId: row.runtimeId, owner: ownerRef, contextId: row.contextId,
      projectPath: row.projectPath, profileId: row.profileId, configRevision: row.configRevision,
      preferences: { projectRoot: preferences.projectRoot, globalRoot: preferences.globalRoot } };
    const scopes = handles.filter(handle => handle.contextId === row.contextId &&
      object(handle.owner).ownerId === ownerRef.ownerId && object(handle.owner).revision === ownerRef.revision)
      .map(handle => { const scope = object(handle.scope); return {
        teamId: scope.teamId, projectId: scope.projectId, workspaceId: scope.workspaceId,
      }; });
    const teamScopes = [...new Map(scopes.map(scope => [JSON.stringify([
      scope.teamId, scope.projectId, scope.workspaceId,
    ]), scope])).values()];
    return runtimeSourceGrantSchema.parse({ targetId: runtimeDigest({ selected, owner: normalizedOwner }),
      ownerId: ownerRef.ownerId, ownerRevision: ownerRef.revision, contextId: row.contextId,
      projectPath: row.projectPath, runtimeId: row.runtimeId, profileId: row.profileId,
      configRevision: row.configRevision, teamScopes });
  });
  return { root, profile, grants };
}
export type DesktopV2ManagementAuthority = ReturnType<typeof captureDesktopV2ManagementAuthority>;

export async function readDesktopV2ManagementJson(path: string, maximum = 2 * 1024 * 1024) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= maximum);
  return object(JSON.parse(await readFile(path, 'utf8')));
}

export async function readDesktopV2ManagementCommands(root: string) {
  const directory = join(root, 'hoststore/management-commands');
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  assert.ok(entries.length <= 64);
  const result: StoredManagementCommand[] = [];
  for (const entry of entries) {
    assert.ok(entry.isFile() && !entry.isSymbolicLink());
    if (/^\.tmp-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(entry.name)) continue;
    assert.match(entry.name, /^[a-f0-9]{64}\.json$/u);
    const { digest, ...body } = await readDesktopV2ManagementJson(join(directory, entry.name));
    assert.equal(digest, managementDigest(body));
    const command = storedManagementCommandSchema.parse(body);
    assert.equal(entry.name, managementDigest(command.commandId) + '.json'); result.push(command);
  }
  assert.equal(new Set(result.map(row => row.commandId)).size, result.length);
  return result;
}

/** A publication is admitted only by its original private descriptor grant and unchanged seed. */
export function readDesktopV2ManagementPublication(authority: DesktopV2ManagementAuthority,
  command: StoredRuntimeSourceCommand, verifyConfiguration = false) {
  assert.equal(command.phase, 'published'); assert.equal(command.resourceHeld, false);
  const input = readOriginalRuntimeSourcePublication(command, grant => {
    const expected = authority.grants.filter(row => row.targetId === grant.targetId);
    assert.equal(expected.length, 1); assert.deepEqual(grant, expected[0]);
    return selectRuntimeSourceSeed(authority.profile, grant);
  });
  const seed = selectRuntimeSourceSeed(authority.profile, input.grant);
  assert.equal(seed.provider, 'opencode');
  if (seed.provider !== 'opencode') throw new Error('Original OpenCode seed unavailable');
  assert.equal(seed.nativeGeneration, 'v2'); assert.equal(seed.protocolRevision, '2.1.4'); assert.ok(seed.embedded);
  assert.equal(input.intent, 'configuration');
  assert.deepEqual(Object.keys(input.candidate).sort(), ['executable', 'openCodeConfiguration', 'openCodePreferences', 'sourceKind']);
  assert.equal(input.candidate.sourceKind, 'captured'); assert.deepEqual(input.candidate.executable, seed.executable);
  const configuration = input.candidate.openCodeConfiguration!;
  assert.equal(configuration.scope, input.grant.projectPath === null ? 'global' : 'project');
  assert.equal(configuration.inlineDigest, null);
  const expectedFiles = [join(seed.environment.HOME!, '.config'), seed.environment.XDG_CONFIG_HOME!]
    .flatMap(directory => ['opencode.json', 'opencode.jsonc'].map(name => join(directory, 'opencode', name)));
  if (configuration.scope === 'project') expectedFiles.push(join(seed.cwd, 'opencode.json'), join(seed.cwd, 'opencode.jsonc'));
  assert.deepEqual(configuration.files.map(row => row.path), expectedFiles);
  if (verifyConfiguration) assert.equal(captureOpenCodeConfigurationSource(seed, configuration).isCurrent(), true);
  const preferences = input.candidate.openCodePreferences!;
  assert.ok([null, 'test-local/TEST-model', 'test-local/TEST-project-model'].includes(preferences.defaultModelId));
  assert.deepEqual(preferences.modelLimitOverrides, {});
  const profileId = 'runtime-source:' + command.revision;
  const profile = openCodeManagementProfileSchema.parse({ ...applyOpenCodeRuntimeSource(seed, input.candidate),
    profileId, configRevision: profileId, executable: input.candidate.executable });
  return { input, profile, evidence: { commandId: command.commandId, sourceId: command.sourceId,
    revision: command.revision, previousRevision: command.expectedRevision, profileId, configRevision: profileId,
    projectPath: input.grant.projectPath, defaultModelId: preferences.defaultModelId } };
}

export function desktopV2ManagementStepSelection(root: string, step: DesktopV2ManagementStep) {
  return step === 'project-default' || step === 'project-test'
    ? { projectPath: join(root, 'workspace'), defaultModelId: step === 'project-test' ? 'test-local/TEST-project-model' : 'test-local/TEST-model' }
    : { projectPath: null, defaultModelId: null };
}

/** Join the original intent to its retained revision; a later current pointer cannot retarget it. */
export function bindDesktopV2ManagementReceipt(authority: DesktopV2ManagementAuthority,
  commands: readonly StoredManagementCommand[], receipt: StoredManagementCommand, step: DesktopV2ManagementStep) {
  const sources = commands.filter((row): row is StoredRuntimeSourceCommand => row.kind === 'runtime.source' &&
    receipt.profileId === 'runtime-source:' + row.revision && receipt.configRevision === 'runtime-source:' + row.revision);
  assert.equal(sources.length, 1, 'one original published source for this exact Settings receipt');
  const selected = readDesktopV2ManagementPublication(authority, sources[0]!);
  const expected = desktopV2ManagementStepSelection(authority.root, step);
  assert.equal(selected.evidence.projectPath, expected.projectPath);
  assert.equal(selected.evidence.defaultModelId, expected.defaultModelId);
  assert.equal(receipt.providerId, 'test-local');
  assert.ok(receipt.kind === 'credential.set' || receipt.kind === 'model.probe');
  return selected;
}

/** At final readback all records, including metadata publications, must be accounted for. */
export function assertDesktopV2ManagementSourceHistory(authority: DesktopV2ManagementAuthority,
  commands: readonly StoredManagementCommand[], rawIndex: unknown, verifyConfiguration = false) {
  assert.ok(commands.every(row => ['runtime.source', 'credential.set', 'model.probe'].includes(row.kind) && !row.resourceHeld));
  const sourceCommands = commands.filter((row): row is StoredRuntimeSourceCommand => row.kind === 'runtime.source');
  const publications = sourceCommands.map(row => readDesktopV2ManagementPublication(authority, row, verifyConfiguration));
  assert.ok(publications.length > 0 && publications.length <= 59);
  const { digest, ...body } = object(rawIndex);
  assert.equal(digest, runtimeDigest(body)); assert.equal(body.schemaVersion, 1);
  assert.deepEqual(Object.keys(body).sort(), ['current', 'records', 'schemaVersion']);
  const records = array(body.records).map(row => runtimeSourceRecordSchema.parse(row)), current = array(body.current).map(row => {
    assert.deepEqual(Object.keys(row).sort(), ['commandId', 'revision', 'sourceId']);
    assert.ok(typeof row.commandId === 'string' && row.commandId.length > 0); assert.match(String(row.sourceId), /^[a-f0-9]{64}$/u);
    assert.match(String(row.revision), /^[a-f0-9]{64}$/u);
    return { commandId: row.commandId, sourceId: String(row.sourceId), revision: String(row.revision) };
  });
  assert.equal(records.length, publications.length); assert.equal(new Set(records.map(row => row.revision)).size, records.length);
  assert.equal(new Set(records.map(row => row.commandId)).size, records.length);
  assert.equal(new Set(current.map(row => row.sourceId)).size, current.length);
  for (const { revision, ...selection } of records) assert.equal(revision, runtimeDigest(selection));
  assert.deepEqual(records.map(row => row.commandId).sort(), sourceCommands.map(row => row.commandId).sort());
  validateRuntimeSourceHistory({ schemaVersion: 1, records, current }, {
    read: commandId => commands.find(row => row.commandId === commandId),
  });
  for (const pointer of current) assert.equal(records.find(row => row.revision === pointer.revision)?.commandId, pointer.commandId);
  return publications.map(row => row.evidence).sort((a, b) => a.commandId.localeCompare(b.commandId));
}
