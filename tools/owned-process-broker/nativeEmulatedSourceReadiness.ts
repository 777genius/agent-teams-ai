/** TEST readback of an original aggregate action; never writes or synthesizes readiness. */
import assert from 'node:assert/strict';

import { FileManagementCommandStore } from '../../packages/legacy-agent-host/dist/adapters/providers/FileManagementCommandStore.js';
import { TeamOwnerStore } from '../../packages/legacy-agent-host/dist/adapters/team/TeamOwnerStore.js';
import { managementDigest } from '../../packages/legacy-agent-host/dist/management/identity.js';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { validateLaunchRecord } from '../../packages/legacy-agent-host/dist/team-launch/validateLaunchRecord.js';
import { readinessOriginDigest } from '../../src/features/agent-backend/main/infrastructure/CapturedLocalModelReadiness';

import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import type { TeamLaunchRecord } from '../../packages/legacy-agent-host/dist/team-launch/contracts.js';

export function readEmulatedSourceActionProbe(options: {
  profile: TeamHostProfile; team: number; handleId: string; contextId: string; commandId: string;
  payload: { launchId: string; rosterRevision: string }; fingerprint: string; captureDigest: string;
}) {
  const definition = options.profile.teams[options.team];
  assert.ok(definition);
  const store = new TeamOwnerStore(options.profile.owner.storageRoot, definition.binding.teamName);
  const record = store.read<TeamLaunchRecord>('launches/' + runtimeDigest(options.payload.launchId) + '.json');
  assert.ok(record);
  validateLaunchRecord(record, options.fingerprint, 1);
  assert.equal(record.startCommandId, options.commandId);
  assert.equal(record.definition.launchId, options.payload.launchId);
  assert.equal(record.definition.rosterRevision, options.payload.rosterRevision);
  assert.equal(runtimeDigest(record.definition.capture), options.captureDigest);
  assert.ok(record.readiness);
  assert.equal(record.readiness.capture, undefined, 'The original aggregate action owns this proof');
  const consumers = record.readiness.consumers.filter(row => row.actionId === options.commandId && row.memberId === 'alice-id');
  assert.equal(consumers.length, 1);
  const consumer = consumers[0]!, member = record.definition.members[0]!;
  assert.equal(consumer.memberId, member.memberId);
  assert.deepEqual(consumer.binding, member.binding);
  assert.equal(consumer.configRevision, member.configRevision);
  assert.equal(consumer.configurationDigest, member.configurationDigest);
  assert.equal(consumer.baseConfigurationDigest, member.baseConfigurationDigest);
  assert.equal(consumer.inputDigest, runtimeDigest(options.payload));
  assert.equal(consumer.disposition, 'consumed');
  assert.equal(consumer.admissionOnly, undefined);
  assert.equal(consumer.initialProfile, undefined);
  assert.equal(consumer.continuation, undefined);
  assert.equal(consumer.policyCommandId, undefined);
  assert.equal(consumer.sourceAttemptId, record.members[0]!.currentAttemptId);
  assert.ok(consumer.groupCommandId);
  const groups = record.readiness.groups.filter(row => row.commandId === consumer.groupCommandId);
  assert.equal(groups.length, 1);
  const group = groups[0]!;
  const receipt = new FileManagementCommandStore(options.profile.owner.storageRoot, true).read(group.commandId);
  assert.ok(receipt && receipt.kind === 'model.probe');
  assert.match(receipt.commandId, /^action-probe-[a-f0-9]{64}$/);
  for (const key of ['commandId', 'profileId', 'configRevision', 'context', 'fingerprint', 'selectionDigest', 'resourceId', 'expiresAt'] as const)
    assert.equal(receipt[key], group[key]);
  assert.equal(receipt.phase, 'completed'); assert.equal(receipt.ok, true); assert.equal(receipt.resourceHeld, false);
  assert.equal(receipt.purpose, 'native-local-readiness-v1'); assert.equal(group.purpose, receipt.purpose);
  assert.match(receipt.profileId, /^team-probe-[a-f0-9]{64}$/); assert.equal(receipt.configRevision, receipt.profileId);
  assert.equal(receipt.providerId, 'test-provider'); assert.equal(receipt.modelId, 'TEST-model');
  assert.equal(receipt.effort, undefined); assert.equal(receipt.modelContext, undefined);
  assert.ok(receipt.readinessScope && receipt.localModelReadinessOrigin && receipt.localModelReadinessPreparation && receipt.readiness);
  assert.equal(receipt.readinessScope.kind, 'team');
  assert.equal(receipt.readinessScope.teamBindingDigest, runtimeDigest(definition.binding));
  assert.equal(receipt.readinessScope.sourceRevision, options.captureDigest);
  assert.equal(receipt.readinessScope.rosterRevision, options.payload.rosterRevision);
  assert.equal(receipt.readinessScope.actionDigest,
    runtimeDigest({ commandId: options.commandId, actor: consumer.actorDigest, inputDigest: consumer.inputDigest }));
  assert.equal(receipt.readinessScope.selectionDigest, runtimeDigest({
    payload: options.payload, targets: [{ binding: consumer.binding, profile: consumer.configurationDigest }],
  }));
  assert.deepEqual(receipt.readinessScope.destinationKeys,
    [runtimeDigest({ launchId: consumer.binding.runId, memberId: consumer.memberId })]);
  assert.equal(group.preparationDigest, managementDigest({ scope: receipt.readinessScope,
    anchor: receipt.localModelReadinessPreparation ?? null, origin: receipt.localModelReadinessOrigin ?? null,
    ...(receipt.nativeFileKeyWitness === undefined ? {} : { nativeFileKeyWitness: managementDigest(receipt.nativeFileKeyWitness) }) }));
  assert.equal(receipt.readinessScope.mechanismDigest, group.mechanismDigest);
  assert.equal(receipt.readinessScope.workspace, definition.savedSettings!.cwd);
  assert.equal(receipt.localModelReadinessPreparation.anchorCommandId, receipt.commandId);
  assert.equal(receipt.localModelReadinessOrigin.ownerDigest, readinessOriginDigest(options.profile.owner));
  assert.equal(receipt.localModelReadinessOrigin.contextId, options.contextId);
  assert.equal(receipt.localModelReadinessOrigin.commandId, options.commandId);
  assert.equal(receipt.localModelReadinessOrigin.selectionDigest,
    readinessOriginDigest({ handleId: options.handleId, scope: definition.scope, payload: options.payload }));
  assert.deepEqual(receipt.localModelReadinessOrigin.workspaces.map(row => row.path), [definition.savedSettings!.cwd]);
  assert.equal(receipt.readiness.evidence.ordinary, 'confirmed');
  assert.equal(receipt.readiness.evidence.decision, 'allow');
  return receipt;
}

/** Passive projection of the existing TEST peer journal, after original cleanup attempts. */
export function observeEmulatedSourcePeerReadiness(
  evidence: Record<string, unknown>, values: readonly Record<string, unknown>[], provider: string
): void {
  if (provider !== 'codex') return;
  try {
    const data = (row: object, key: string): unknown => {
      const property = Object.getOwnPropertyDescriptor(row, key);
      if (property && !('value' in property)) throw new Error('TEST non-data peer observation');
      return property?.value;
    };
    const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
    const events: Record<string, unknown>[] = [];
    let truncated = false;
    for (const [index, value] of values.entries()) {
      if (data(value, 'provider') !== 'codex') continue;
      const event = data(value, 'event');
      if (typeof event !== 'string' ||
          !['launch', 'mcp-catalog', 'managed-configuration-read', 'connected', 'exit'].includes(event)) continue;
      if (events.length === 64) { truncated = true; break; }
      const pid = data(value, 'pid'), role = data(value, 'role');
      assert.ok(integer(pid) && pid > 0 && (role === 'runtime' || role === 'management'));
      const row: Record<string, unknown> = { ordinal: index + 1, event, pid, role };
      if (event === 'launch') {
        const parentPid = data(value, 'parentPid'), argc = data(value, 'argc');
        assert.ok(integer(parentPid) && parentPid > 0 && integer(argc, 1024));
        row.parentPid = parentPid; row.argc = argc;
      } else if (event === 'mcp-catalog') {
        const configuredServers = data(value, 'configuredServers');
        assert.ok(integer(configuredServers, 256)); row.configuredServers = configuredServers;
      } else if (event === 'managed-configuration-read') {
        const selected = data(value, 'selectedServers');
        assert.ok(Array.isArray(selected) && selected.length <= 1 && selected.every(name => name === 'team'));
        row.selectedServerCount = selected.length; row.teamSelected = selected.includes('team');
      } else if (event === 'connected') {
        const tools = data(value, 'tools');
        assert.ok(Array.isArray(tools) && tools.length <= 256 && tools.every(name => typeof name === 'string'));
        row.toolCount = tools.length;
      } else {
        const code = data(value, 'code');
        assert.ok(code === 0 || code === 1); row.code = code;
      }
      events.push(row);
    }
    evidence.sourcePeerReadiness = {
      status: 'observed', provider, capturePoint: 'existing-post-cleanup-effects-read',
      atomicWithReadinessFailure: false, events, truncated,
    };
  } catch {
    try { evidence.sourcePeerReadiness = { status: 'unknown', provider }; }
    catch { /* Passive evidence cannot replace the original failure or pin check. */ }
  }
}
