import { TeamLaunchError } from '../team-launch/contracts.js';
import { z } from 'zod';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import { assertCapturedRosterCurrent } from './teamRoster.js';
import { assertRuntimeWorktree } from './runtimeWorktreeCapture.js';
import { executeMemberAction, parseMemberAction } from './executeMemberAction.js';
import { executeUnconfiguredSkip } from './executeUnconfiguredSkip.js';
import { readMemberActionView } from './readMemberActions.js';
import { captureNativeMemberActionAdmission } from './nativeMemberActionAdmission.js';
import type { captureNativeInputAuthority } from './captureNativeInputAuthority.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import type { NativeLaunchRetryAuthority } from '../team-launch/launchRetry.js';
const id = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => !s.includes('\0'));
export type NativeMemberActionOperation = 'prepare' | 'execute' | 'read' | 'lookup' | 'retry';
export function parseNativeMemberActionRequest(
  operation: NativeMemberActionOperation,
  commandId: string,
  raw: unknown
) {
  return operation === 'prepare' || operation === 'execute'
    ? parseMemberAction(commandId, raw)
    : z
        .object({
          launchId: id,
          memberId: id,
          ...(operation === 'lookup' ? { originalCommandId: id } : {}),
          ...(operation === 'retry' ? { rosterRevision: id, attemptId: id } : {}),
        })
        .strict()
        .parse(raw);
}
/** Trusted native composition only. Same journal/transition as the human UI; no RPC accepts this source proof. */
export async function executeNativeMemberAction(
  options: {
    team: HostedTeam;
    launch: TeamLaunchOwner;
    entries: Map<string, MemberEntry>;
    runtime: RuntimeOwner;
    source: ReturnType<typeof captureNativeInputAuthority>;
    assertCurrent(): void;
    isSealed(): boolean;
  },
  operation: NativeMemberActionOperation,
  commandId: string,
  raw: unknown
) {
  const parsed = parseNativeMemberActionRequest(operation, commandId, raw);
  if (parsed.launchId !== options.source.team.source.runId)
    throw new RuntimeOwnerError('forbidden');
  const { team, launch, source, runtime } = options;
  const admission = captureNativeMemberActionAdmission({ ...options, memberId: parsed.memberId });
  const actions = admission.actions,
    actor = admission.journalAuthority.captureActor();
  const own = (row: NonNullable<ReturnType<typeof actions.lookup>>) => {
    if (runtimeDigest(row.actor) !== runtimeDigest(actor)) throw new RuntimeOwnerError('forbidden');
    return row;
  };
  const entry = [...options.entries.values()].find(
    (e) => e.team === team && e.binding.memberId === parsed.memberId
  );
  const target = () => {
    if (!entry) throw new RuntimeOwnerError('hold');
    return admission.captureTarget(entry);
  };
  const retryAuthority: NativeLaunchRetryAuthority = {
    ...admission.journalAuthority,
    assertCurrent: () => admission.assertWorkCurrent(entry),
    captureTarget(memberId) {
      if (memberId !== parsed.memberId) throw new RuntimeOwnerError('forbidden');
      return target();
    },
  };
  const assertReadCurrent = () => {
    source.assertTeamCurrent();
    options.assertCurrent();
  };
  if (operation === 'lookup') {
    const original = (parsed as { originalCommandId: string }).originalCommandId;
    const row = actions.lookup(original);
    if (row && row.input.memberId !== parsed.memberId) throw new RuntimeOwnerError('conflict');
    const result = row
      ? readMemberActionView(actions.read(parsed.memberId), own(row), runtime)
      : launch.readNativeRetry(original, parsed.memberId, retryAuthority);
    assertReadCurrent();
    return result;
  }
  if (operation === 'read') {
    const view = actions.read(parsed.memberId);
    const result = {
      launchId: view.launchId,
      rosterRevision: view.rosterRevision,
      memberId: parsed.memberId,
      actions: view.actions
        .filter((row) => runtimeDigest(row.actor) === runtimeDigest(actor))
        .map((row) => readMemberActionView(view, row, runtime)),
      retries: view.retries.flatMap((row) => {
        try {
          const retained = launch.readNativeRetry(row.commandId, parsed.memberId, retryAuthority);
          return retained ? [retained] : [];
        } catch (error) {
          if (error instanceof TeamLaunchError && error.reason === 'retry-actor') return [];
          throw error;
        }
      }),
    };
    assertReadCurrent();
    return result;
  }
  admission.assertCurrent();
  assertCapturedRosterCurrent(team, source.team.principalId);
  if (operation === 'retry') {
    if (actions.lookup(commandId)) throw new RuntimeOwnerError('conflict');
    const retry = parsed as {
      launchId: string;
      memberId: string;
      rosterRevision: string;
      attemptId: string;
    };
    if (!entry) throw new RuntimeOwnerError('hold');
    admission.assertWorkCurrent(entry);
    await assertRuntimeWorktree(entry);
    admission.assertWorkCurrent(entry);
    launch.retry(
      {
        commandId,
        launchId: retry.launchId,
        rosterRevision: retry.rosterRevision,
        attemptId: retry.attemptId,
        memberIds: [retry.memberId],
      },
      retryAuthority
    );
    source.assertCurrent();
    return launch.readNativeRetry(commandId, parsed.memberId, retryAuthority);
  }
  const input = parseMemberAction(commandId, raw);
  const known = actions.lookup(commandId);
  if (known) own(known);
  // A command already owned by the existing technical retry cannot change intent type.
  if (!known) {
    try {
      if (launch.readNativeRetry(commandId, parsed.memberId, retryAuthority))
        throw new RuntimeOwnerError('conflict');
    } catch (error) {
      if (error instanceof RuntimeOwnerError) throw error;
      if (error && typeof error === 'object' && 'code' in error && error.code === 'forbidden')
        throw new RuntimeOwnerError('conflict');
      throw error;
    }
  }
  const row = entry
    ? await executeMemberAction(
        {
          entry,
          launch,
          runtime,
          principalId: source.team.principalId,
          admission,
          assertWriter: options.assertCurrent,
          isSealed: options.isSealed,
          assertNewWorkAllowed: () => admission.assertWorkCurrent(entry),
          verifyNewWorkAllowed: assertRuntimeWorktree,
          rekey(before, selected) {
            options.entries.delete(runtimeDigest(before));
            options.entries.set(runtimeDigest(selected.binding), selected);
          },
        },
        operation,
        commandId,
        raw
      )
    : executeUnconfiguredSkip(
        {
          actions,
          assertCurrent: admission.assertCurrent,
          installSkipped() {
            const member = team.definition.members.find((m) => m.memberId === parsed.memberId);
            if (!member) throw new RuntimeOwnerError('conflict');
            member.launchPolicy = 'skip';
          },
        },
        operation,
        input
      );
  source.assertCurrent();
  options.assertCurrent();
  return row ? readMemberActionView(actions.read(parsed.memberId), row, runtime) : null;
}
