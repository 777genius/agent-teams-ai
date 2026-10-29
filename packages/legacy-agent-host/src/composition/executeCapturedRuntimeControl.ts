import { z } from 'zod';
import { RuntimeOwnerError } from '../runtime/contracts.js';
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

/** Existing captured member controls; the coordinator retains registry and lifecycle ownership. */
export async function executeCapturedRuntimeControl(
  options: {
    teams: ReadonlyMap<string, HostedTeam>;
    capturedTeams: ReadonlyMap<string, HostedTeam>;
    entries: ReadonlyMap<string, MemberEntry>;
    launches: ReadonlyMap<string, TeamLaunchOwner>;
    runtime: RuntimeOwner;
    interactionControls: HostInteractionControls;
    principalId: string;
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
  commandId?: string
): Promise<JsonValue> {
  if (options.isSealed()) throw new RuntimeOwnerError('hold');
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
    await assertRuntimeWorktree(entry);
    assertAuthority?.();
    if (!entry.team.owner.authorizeMemberBinding(entry.binding, 'admit'))
      throw new RuntimeOwnerError('forbidden');
    const opening = options.launches
      .get(teamId)!
      .startMember(entry.profile.memberId, assertAuthority);
    if (opening) await opening;
    record = options.runtime.readSession(entry.binding).record;
    options.kick();
  } else if (operation === 'read') record = options.runtime.readSession(entry.binding).record;
  else if (operation === 'dispatch') {
    options.kick();
    await options.dispatchSettled();
    record = options.runtime.readSession(entry.binding).record;
  } else if (operation === 'stop') {
    record = await options.runtime.stopSession(entry.binding, assertAuthority);
    await options.closeEndpoint(entry);
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
