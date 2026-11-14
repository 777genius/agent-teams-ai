import { z } from 'zod';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import { attachMemberModelReadiness, captureActionModelReadiness,
  capturePreparedModelReference, inspectMemberModelReadiness } from './prepareTeamModelReadiness.js';
import { attachInitialRuntimeModelAdmission } from './initialRuntimeModelAdmission.js';
import type { LocalModelReadinessAction } from './prepareTeamModelReadiness.js';
import type { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';
import { assertRuntimeWorktree } from './runtimeWorktreeCapture.js';
import { captureRuntimeControlAuthority } from './runtimeControlAuthority.js';
import { resolveRuntimeControlEntry } from './resolveRuntimeControlEntry.js';
import { interactionPreviewInput } from './HostInteractionControls.js';
import {
  runtimeMember as member,
  runtimeControlId as id,
  runtimeActivityCursor as activityCursor,
  runtimeInteraction as interaction,
} from './runtimeControlValues.js';
import { decodeActivityCursor } from './runtimeActivityProjection.js';
import { restoreMemberSession } from './restoreMemberSession.js';
import { readMemberCheckpoints } from './readMemberCheckpoints.js';
import { settleLaunchResumeRefusal } from './prepareLaunchResume.js';
import type { HostInteractionControls } from './HostInteractionControls.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import type { RuntimeBinding, RuntimeSessionRecord } from '../runtime/contracts.js';
import type {
  RuntimeActivityCursor,
  RuntimeActivityFeed,
  RuntimeActivitySnapshot,
} from '../runtime/activityContracts.js';
import type { JsonValue } from '../contracts.js';
import type { RuntimeSourceProcessOrigin } from './runtimeSourceProcessOrigin.js';

/** Existing captured member controls; the coordinator retains registry and lifecycle ownership. */
export async function executeCapturedRuntimeControl(
  options: {
    teams: ReadonlyMap<string, HostedTeam>;
    capturedTeams: ReadonlyMap<string, HostedTeam>;
    entries: ReadonlyMap<string, MemberEntry>;
    launches: ReadonlyMap<string, TeamLaunchOwner>;
    retainedLaunches: ReadonlyMap<string, { team: HostedTeam; launch: TeamLaunchOwner }>;
    modelReadiness?: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget' | 'admitTeamProbeProfile'>;
    captureProcessOrigin?(entry: MemberEntry): RuntimeSourceProcessOrigin | undefined;
    runtime: RuntimeOwner;
    interactionControls: HostInteractionControls;
    principalId: string;
    hostIncarnation: string;
    isSealed(): boolean;
    assertWriter(): void;
    kick(): void;
    dispatchSettled(): Promise<void> | undefined;
    closeEndpoint(entry: MemberEntry): Promise<void>;
    rekey(previous: RuntimeBinding, entry: MemberEntry): void;
    projection(
      entry: MemberEntry,
      record: RuntimeSessionRecord | undefined,
      binding?: RuntimeBinding
    ): JsonValue;
    activityProjection(
      entry: MemberEntry,
      source: RuntimeActivityFeed | RuntimeActivitySnapshot,
      requested?: RuntimeActivityCursor
    ): JsonValue;
  },
  teamId: string,
  operation: string,
  raw: unknown,
  commandId?: string,
  readiness?: LocalModelReadinessAction
): Promise<JsonValue> {
  if (options.isSealed()) throw new RuntimeOwnerError('hold');
  if (readiness && operation !== 'open') throw new RuntimeOwnerError('invalid');
  if (operation === 'approval.settings.read' || operation === 'approval.settings.update')
    return options.interactionControls.executeSettings(options.teams.get(teamId), operation, raw);
  const parsed =
    operation === 'interaction.preview.read'
      ? interactionPreviewInput.parse(raw)
      : operation === 'checkpoints.read'
        ? member.extend({ expectedGeneration: id }).strict().parse(raw)
        : operation === 'restore'
          ? member
              .extend({
                reference: z.string().regex(/^cp1-[a-f0-9]{64}$/),
                expectedGeneration: id,
                resumeId: id.optional(),
              })
              .strict()
              .parse(raw)
          : operation === 'interrupt'
            ? member.extend({ inputId: id }).strict().parse(raw)
            : operation === 'interaction'
              ? interaction.parse(raw)
              : operation === 'checkpoint'
                ? member.extend({ checkpointId: id }).strict().parse(raw)
                : operation === 'activity.feed'
                  ? member.extend({ cursor: activityCursor }).strict().parse(raw)
                  : member.parse(raw);
  const entry = resolveRuntimeControlEntry({
    entries: options.entries.values(),
    capturedTeam: options.capturedTeams.get(teamId),
    teamId,
    operation,
    parsed,
    principalId: options.principalId,
    assertWriter: options.assertWriter,
  });
  if (operation === 'interaction.preview.read')
    return { ...options.interactionControls.preview(entry, raw) };
  const readOnly =
    operation === 'read' || operation === 'checkpoints.read' || operation.startsWith('activity.');
  const assertAuthority = readOnly
    ? undefined
    : captureRuntimeControlAuthority({
        entry,
        principalId: options.principalId,
        assertWriter: () => options.assertWriter(),
        isSealed: () => options.isSealed(),
        restore: operation === 'restore',
      });
  assertAuthority?.();
  if (operation === 'checkpoints.read') return { ...readMemberCheckpoints(entry, options.runtime) };
  if (operation === 'restore') {
    await assertRuntimeWorktree(entry);
    assertAuthority?.();
    if (!commandId) throw new RuntimeOwnerError('invalid');
    const input = member
      .extend({
        reference: z.string().regex(/^cp1-[a-f0-9]{64}$/),
        expectedGeneration: id,
        resumeId: id.optional(),
      })
      .strict()
      .parse(raw);
    const launch = options.launches.get(teamId)!;
    launch.requestResumeMember(input.resumeId, {
      memberId: input.memberId,
      sourceGeneration: input.expectedGeneration,
      reference: input.reference,
      commandId,
    });
    let restored: Awaited<ReturnType<typeof restoreMemberSession>>;
    try {
      restored = await restoreMemberSession({
        entry,
        runtime: options.runtime,
        launch,
        commandId,
        reference: input.reference,
        expectedGeneration: input.expectedGeneration,
        assertAuthority,
        rekey: options.rekey,
      });
    } catch (error) {
      settleLaunchResumeRefusal(
        entry,
        options.runtime,
        launch,
        {
          ...(input.resumeId === undefined ? {} : { resumeId: input.resumeId }),
          commandId,
          sourceGeneration: input.expectedGeneration,
        },
        error
      );
      throw error;
    }
    options.assertWriter();
    if (
      options.isSealed() ||
      !entry.team.owner.authorizeRuntimeAccess(options.principalId, restored.binding, 'read')
    )
      throw new RuntimeOwnerError('forbidden');
    options.kick();
    return options.projection(entry, restored.record, restored.binding);
  }
  if (operation === 'activity.snapshot') {
    const snapshot = options.runtime.readActivitySnapshot(entry.binding);
    return options.activityProjection(entry, snapshot);
  }
  if (operation === 'activity.feed') {
    const cursor = decodeActivityCursor(
      member.extend({ cursor: activityCursor }).strict().parse(raw).cursor
    );
    return options.activityProjection(
      entry,
      options.runtime.readActivityFeed(entry.binding, cursor),
      cursor
    );
  }
  let record: RuntimeSessionRecord | undefined;
  if (operation === 'open') {
    const retained = options.retainedLaunches.get(runtimeDigest({ teamId, launchId: entry.binding.runId }));
    const launch = retained?.launch ?? options.launches.get(teamId)!;
    let preparation: ReturnType<typeof captureActionModelReadiness> | undefined;
    let actorDigest: string | undefined;
    if (entry.profile.provider === 'opencode') {
      if (!retained || retained.team.owner !== entry.team.owner ||
          runtimeDigest(retained.team.definition.binding) !== runtimeDigest(entry.team.definition.binding) ||
          !assertAuthority) throw new RuntimeOwnerError('hold');
      const current = options.runtime.readSession(entry.binding);
      // The original seed has no Runtime row until the first launch claim.
      const initialBeforeOpen = current.record === undefined && !current.attached &&
        entry.initialModelAdmission !== undefined && entry.selection === undefined;
      if (initialBeforeOpen || current.record?.phase === 'unopened' && current.record.custody === 'owned' && !current.attached) {
        actorDigest = runtimeDigest(entry.team.owner.withLaunchAuthority(options.principalId, 'control',
          revision => ({ principalId: options.principalId, revision })));
        if (!readiness && entry.initialModelAdmission && !entry.selection) {
          if (!commandId) throw new RuntimeOwnerError('hold');
          attachInitialRuntimeModelAdmission({ launch, entries: [entry], method: 'runtime.open',
            teamId, commandId, payload: raw, actorDigest, hostIncarnation: options.hostIncarnation,
            captureReference: capturePreparedModelReference,
            ...(options.modelReadiness ? { management: options.modelReadiness } : {}), assertCurrent: assertAuthority });
        }
        let qualified = false;
        try {
          const selected = inspectMemberModelReadiness({ ...(options.modelReadiness ? { management: options.modelReadiness } : {}),
            launch, entry, hostIncarnation: options.hostIncarnation, assertCurrent: assertAuthority });
          const reference = selected.reference;
          const initialReference = reference && entry.initialModelAdmission?.admissions.some(admission =>
            admission.targets.some(target => target.memberId === entry.profile.memberId &&
              target.source.kind === 'native-local-readiness' && target.source.probe.commandId === reference.commandId &&
              target.source.probe.profileId === reference.profileId && target.source.probe.configRevision === reference.configRevision &&
              target.source.probe.context === reference.context));
          qualified = !readiness || selected.kind !== 'initial' && !initialReference;
        } catch { assertAuthority(); }
        if (!qualified) {
          if (!options.modelReadiness || !commandId || !readiness || parsed.expectedGeneration !== entry.binding.generation)
            throw new RuntimeOwnerError('hold');
          preparation = captureActionModelReadiness({ management: options.modelReadiness, launch,
            targets: [{ entry, profile: entry.profile, binding: entry.binding }], commandId,
            ...(options.captureProcessOrigin ? { captureProcessOrigin: options.captureProcessOrigin } : {}),
            payload: raw, actorDigest, readiness, assertCurrent: assertAuthority });
        }
      }
    }
    await assertRuntimeWorktree(entry);
    assertAuthority?.();
    if (!entry.team.owner.authorizeMemberBinding(entry.binding, 'admit'))
      throw new RuntimeOwnerError('forbidden');
    if (preparation) {
      const reference = (await preparation.prepare()).get(entry.profile.memberId);
      assertAuthority?.();
      if (!reference) throw new RuntimeOwnerError('hold');
      attachMemberModelReadiness({ launch, entry, reference, commandId: commandId!, actorDigest: actorDigest!,
        inputDigest: preparation.inputDigest, cutoff: preparation.cutoff });
    }
    const opening = launch.startMember(entry.profile.memberId, assertAuthority);
    if (opening) await opening;
    record = options.runtime.readSession(entry.binding).record;
    options.kick();
  } else if (operation === 'read') record = options.runtime.readSession(entry.binding).record;
  else if (operation === 'dispatch') {
    options.kick();
    await options.dispatchSettled();
    record = options.runtime.readSession(entry.binding).record;
  } else if (operation === 'stop') {
    if (entry.profile.provider === 'opencode') {
      const launch = options.retainedLaunches.get(runtimeDigest({ teamId, launchId: entry.binding.runId }))?.launch;
      launch?.retireModelReadiness(entry.profile.memberId);
      const cancellation = options.modelReadiness?.probes.cancelTeamPreparations(
        runtimeDigest(entry.team.definition.binding), undefined,
        runtimeDigest({ launchId: entry.binding.runId, memberId: entry.profile.memberId }));
      const [stopped, preparations] = await Promise.allSettled([
        options.runtime.stopSession(entry.binding, assertAuthority), cancellation,
      ]);
      await options.closeEndpoint(entry);
      if (stopped.status !== 'fulfilled' || preparations.status !== 'fulfilled') throw new RuntimeOwnerError('hold');
      record = stopped.value;
    } else {
      record = await options.runtime.stopSession(entry.binding, assertAuthority);
      await options.closeEndpoint(entry);
    }
  } else if (operation === 'reconcile') record = options.runtime.reconcileSession(entry.binding);
  else if (operation === 'interrupt')
    record = await options.runtime.interrupt(
      entry.binding,
      member.extend({ inputId: id }).strict().parse(raw).inputId,
      assertAuthority
    );
  else if (operation === 'interaction') {
    const input = interaction.parse(raw);
    record = await options.runtime.respondToInteraction(
      entry.binding,
      input.inputId,
      input.interactionRef,
      input.reply,
      assertAuthority
    );
  } else if (operation === 'checkpoint') {
    const input = member.extend({ checkpointId: id }).strict().parse(raw);
    const receipt = await options.runtime.captureCheckpoint(
      {
        binding: entry.binding,
        checkpointId: input.checkpointId,
      },
      assertAuthority
    );
    if (!entry.team.owner.authorizeRuntimeAccess(options.principalId, entry.binding, 'control'))
      throw new RuntimeOwnerError('forbidden');
    return JSON.parse(JSON.stringify(receipt)) as JsonValue;
  } else throw new RuntimeOwnerError('invalid');
  if (
    !(operation === 'read'
      ? entry.team.owner.withLaunchAuthority(options.principalId, 'read', () => true)
      : entry.team.owner.authorizeRuntimeAccess(options.principalId, entry.binding, 'control'))
  )
    throw new RuntimeOwnerError('forbidden');
  return options.projection(entry, record);
}
