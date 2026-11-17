/** Existing native cases only: one private proof before the first original business Host. */
import assert from 'node:assert/strict';

import { acquireProfileWriterLease } from '../../../dist/adapters/profile/ProfileWriterLease.js';
import { FileManagementCommandStore } from '../../../dist/adapters/providers/FileManagementCommandStore.js';
import { ProviderManagementCoordinator } from '../../../dist/composition/ProviderManagementCoordinator.js';
import { readTeamHostProfile } from '../../../dist/composition/readProfile.js';
import { teamModelProbeProfile } from '../../../dist/composition/teamLaunchModelProbe.js';
import { initialRuntimeModelProbeScope } from '../../../dist/composition/initialRuntimeModelAdmission.js';
import { managementDigest } from '../../../dist/management/identity.js';
import { nativeLocalReadinessPurpose } from '../../../dist/management/ModelProbeOwner.js';
import { providerManagementProfileSchema } from '../../../dist/management/profile.js';
import { tick } from '../native-host.ts';

import type { TeamHostProfile } from '../../../dist/composition/TeamHost.js';
import type { ModelProbeInput } from '../../../dist/management/ModelProbeOwner.js';
import type { InitialRuntimeModelProbeLocator } from '../../../dist/composition/initialRuntimeModelAdmission.js';
import type { startOpenCodeModel } from './model.ts';

type Model = Awaited<ReturnType<typeof startOpenCodeModel>>;
type Evidence = {
  purpose: typeof nativeLocalReadinessPurpose;
  nativeGeneration: 'v1' | 'v2';
  status: 'unqualified' | 'INCOMPLETE' | 'PASS';
  cleanup: boolean | null;
  profileId: string;
  configRevision: string;
  context: string;
  originalReceiptUnchanged?: true;
  receipt?: { commandId: string; phase: string; ok: boolean; resourceHeld: boolean; expiresAt: number };
  modelRequests?: number;
  metadataRequests?: number;
};
export interface NativeCoordinationFixture {
  readonly evidence: Evidence;
  readonly initialReadiness: InitialRuntimeModelProbeLocator;
  run(options: { profilePath: string; profileSha256: string; model: Model; signal?: AbortSignal }): Promise<void>;
}

/** Complete this real management recipe before the original profile is serialized or a writer is acquired. */
export function captureNativeCoordinationFixture(profile: TeamHostProfile,
  limits?: { contextTokens: number; outputTokens: number }): NativeCoordinationFixture {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v24.21.0');
  const member = profile.runtime?.members[0];
  assert.ok(member?.provider === 'opencode');
  const memberDigest = managementDigest(member), derived = teamModelProbeProfile(member);
  assert.equal(derived.provider, 'opencode');
  const selected = providerManagementProfileSchema.parse({
    ...derived, profileId: 'TEST-native-coordination-' + memberDigest,
  });
  assert.ok(!(profile.management ?? []).some(row => row.profileId === selected.profileId));
  profile.management = [...(profile.management ?? []), selected];
  const variant = member.nativeOptions.variant;
  assert.ok(variant === undefined || variant === 'high');
  assert.equal(variant, member.nativeGeneration === 'v2' ? 'high' : undefined);
  const context = managementDigest({ owner: profile.owner, member, selected, limits });
  const input: ModelProbeInput = {
    commandId: 'TEST-native-coordination-' + context,
    profileId: selected.profileId, configRevision: selected.configRevision,
    context, providerId: member.nativeOptions.providerId,
    modelId: member.nativeOptions.providerId + '/' + member.model,
    ...(variant ? { effort: variant } : {}),
    ...(limits ? { limits } : {}),
  };
  const lookup = { commandId: input.commandId, profileId: input.profileId, configRevision: input.configRevision };
  const evidence: Evidence = {
    purpose: nativeLocalReadinessPurpose, nativeGeneration: member.nativeGeneration === 'v2' ? 'v2' : 'v1',
    status: 'unqualified', cleanup: null, profileId: selected.profileId, configRevision: selected.configRevision, context,
  };
  let attempted = false;
  return {
    evidence,
    initialReadiness: { memberId: member.memberId, ...lookup, context },
    async run({ profilePath, profileSha256, model, signal }) {
      assert.equal(attempted, false, 'one original qualification invocation');
      attempted = true; evidence.status = 'INCOMPLETE';
      assert.ok(model.coordination && model.localReadiness);
      signal?.throwIfAborted();
      const lease = acquireProfileWriterLease(profile.owner.storageRoot);
      let manager: ProviderManagementCoordinator | undefined;
      let store: FileManagementCommandStore | undefined, admissionDeadline: number | undefined;
      let failed = false, failure: unknown, admitted = false;
      let originalReceipt: string | undefined;
      const cleanupErrors: unknown[] = [];
      const assertCurrent = () => {
        lease.assertCurrent();
        const original = readTeamHostProfile(profilePath, profileSha256);
        assert.equal(managementDigest(original.owner), managementDigest(profile.owner));
        assert.equal(managementDigest(original.runtime?.members.find(row =>
          row.teamId === member.teamId && row.memberId === member.memberId)), memberDigest);
        assert.equal(managementDigest(original.management?.find(row => row.profileId === selected.profileId)),
          managementDigest(selected), 'same original fully captured management recipe');
        assert.equal(managementDigest(original.runtime?.initialModelAdmissions),
          managementDigest(profile.runtime?.initialModelAdmissions), 'same original initial intent');
      };
      const current = () => { signal?.throwIfAborted(); assertCurrent(); return true; };
      const cancel = () => manager?.seal();
      try {
        current();
        store = new FileManagementCommandStore(profile.owner.storageRoot);
        assert.equal([...store.list()].length, 0, 'the original native fixture has not admitted management work');
        manager = new ProviderManagementCoordinator(profile.management!, assertCurrent, profile.owner.storageRoot);
        signal?.addEventListener('abort', cancel, { once: true });
        current();
        model.coordination.arm();
        const admissions = profile.runtime?.initialModelAdmissions?.filter(row => row.targets.some(target =>
          target.memberId === member.memberId && target.source.kind === 'native-local-readiness' &&
          managementDigest(target.source.probe) === managementDigest({ ...lookup, context }))) ?? [];
        assert.equal(admissions.length, 1, 'one original scoped allocation destination');
        const scope = initialRuntimeModelProbeScope(admissions[0]!, member,
          Date.now() + (selected.modelProbeTimeoutMs ?? 90000));
        let observed = manager.startNativeReadiness(input, current, scope);
        admitted = true;
        const deadline = admissionDeadline = observed.expiresAt;
        assert.ok(deadline > Date.now() && deadline - Date.now() <= 90000);
        while (observed.phase === 'running' && Date.now() < deadline) {
          await tick(); current();
          const next = manager.probes.read(lookup); assert.ok(next); observed = next;
        }
        current();
        assert.equal(observed.phase, 'completed', 'actual original native compound readiness completed');
        assert.equal(observed.ok, true);
        const proof = manager.probes.readNativeReadiness({ ...lookup, context });
        assert.ok(proof?.ok);
        assert.equal(proof.readiness.evidence.ordinary, 'confirmed');
        assert.equal(proof.readiness.evidence.coordination, 'compatible');
        assert.equal(proof.readiness.evidence.decision, 'allow');
        assert.equal(proof.readiness.context, context);
        const saved = store.read(input.commandId);
        assert.ok(saved?.kind === 'model.probe');
        assert.equal(saved.purpose, nativeLocalReadinessPurpose); assert.equal(saved.context, context);
        assert.equal(saved.phase, 'completed'); assert.equal(saved.ok, true); assert.equal(saved.resourceHeld, false);
        assert.equal(saved.expiresAt, deadline);
        assert.deepEqual(saved.readinessScope, scope);
        assert.deepEqual(proof.readiness, saved.readiness);
        assert.equal(proof.readiness.selectionDigest, saved.selectionDigest);
        assert.equal(model.localReadiness.ordinary.length, 1); assert.equal(model.localReadiness.inventoryReads, 1);
        assert.equal(model.localReadiness.ordinary[0]?.requestedModel, member.model);
        assert.equal(model.localReadiness.ordinary[0]?.requestedEffort, variant);
        if (limits) assert.equal(model.localReadiness.ordinary[0]?.requestedOutputTokens, limits.outputTokens);
        assert.equal(model.coordination.observations.length, 3); assert.deepEqual(model.failures, []);
        assert.equal(model.observations.length, 0, 'no business model input before original writer release');
        originalReceipt = JSON.stringify(saved);
        evidence.receipt = { commandId: saved.commandId, phase: saved.phase, ok: saved.ok,
          resourceHeld: saved.resourceHeld, expiresAt: saved.expiresAt };
        evidence.modelRequests = model.localReadiness.ordinary.length + model.coordination.observations.length;
        evidence.metadataRequests = model.localReadiness.inventoryReads;
      } catch (error) { failed = true; failure = error; }
      finally {
        signal?.removeEventListener('abort', cancel);
        try {
          await manager?.close();
          assertCurrent();
          assert.ok(store || !admitted);
          assert.ok([...(store?.list() ?? [])].every(row => !row.resourceHeld), 'original probe custody is released');
          if (originalReceipt !== undefined) {
            assert.equal(JSON.stringify(store!.read(input.commandId)), originalReceipt);
            evidence.originalReceiptUnchanged = true;
          }
          evidence.cleanup = true;
        } catch (error) { evidence.cleanup = false; cleanupErrors.push(error); }
        if (admitted && !originalReceipt && store) {
          // Read-only original durable outcome after close, never a new operation.
          try {
            lease.assertCurrent();
            const saved = store.read(input.commandId);
            if (saved?.kind === 'model.probe') evidence.receipt = { commandId: saved.commandId,
              phase: saved.phase, ok: saved.ok, resourceHeld: saved.resourceHeld, expiresAt: saved.expiresAt };
          } catch { /* Absence is not manufactured into a receipt. */ }
        }
        try { lease.release(); } catch (error) { evidence.cleanup = false; cleanupErrors.push(error); }
      }
      if (failed && cleanupErrors.length)
        throw new AggregateError([failure, ...cleanupErrors], 'Original coordination and cleanup failed');
      if (failed) throw failure;
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Original coordination cleanup failed');
      signal?.throwIfAborted();
      assert.ok(admissionDeadline !== undefined && Date.now() < admissionDeadline,
        'qualification and original cleanup use the same admission deadline');
      model.coordination.finish();
      evidence.status = 'PASS';
    },
  };
}
