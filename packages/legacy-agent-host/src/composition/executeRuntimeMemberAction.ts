import { executeNativeRuntimeMemberAction } from './executeNativeRuntimeMemberAction.js';
import type { NativeMemberActionSource } from './nativeMemberActionAdmission.js';
import { z } from 'zod';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import { assertCapturedRosterCurrent } from './teamRoster.js';
import { assertRuntimeWorktree } from './runtimeWorktreeCapture.js';
import { executeMemberAction, parseMemberAction } from './executeMemberAction.js';
import { executeUnconfiguredSkip } from './executeUnconfiguredSkip.js';
import { readMemberActionView, readMemberActions } from './readMemberActions.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import type { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';
import type { LocalModelReadinessAction } from './prepareTeamModelReadiness.js';
const id = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => !s.includes('\0'));
export type RuntimeMemberActionOperation = 'prepare' | 'execute' | 'read' | 'lookup';
/** Team/run exact lookup; an absent member never selects another member/default recipe. */
export async function executeRuntimeMemberAction(
  options: {
    retainedLaunches: ReadonlyMap<string, { team: HostedTeam; launch: TeamLaunchOwner }>;
    entries: Map<string, MemberEntry>;
    runtime: RuntimeOwner;
    principalId: string;
    nativeSource?: NativeMemberActionSource;
    modelReadiness?: Pick<ProviderManagementCoordinator, 'probes' | 'readinessTarget' | 'admitTeamProbeProfile'>;
    assertCurrent(): void;
    isSealed(): boolean;
  },
  teamId: string,
  operation: RuntimeMemberActionOperation | 'retry',
  commandId: string,
  raw: unknown,
  readiness?: LocalModelReadinessAction
) {
  if (readiness && (operation !== 'execute' || options.nativeSource)) throw new RuntimeOwnerError('invalid');
  if (options.nativeSource)
    return executeNativeRuntimeMemberAction(
      options,
      options.nativeSource,
      teamId,
      operation,
      commandId,
      raw
    );
  if (operation === 'retry') throw new RuntimeOwnerError('invalid');
  const parsed =
    operation === 'prepare' || operation === 'execute'
      ? parseMemberAction(commandId, raw)
      : z
          .object({
            launchId: id,
            memberId: id,
            ...(operation === 'lookup' ? { originalCommandId: id } : {}),
          })
          .strict()
          .parse(raw);
  options.assertCurrent();
  const retained = options.retainedLaunches.get(
    runtimeDigest({ teamId, launchId: parsed.launchId })
  );
  if (!retained || retained.team.definition.binding.teamId !== teamId)
    throw new RuntimeOwnerError('conflict');
  const { team, launch } = retained,
    actions = launch.memberActions();
  if (operation === 'read') return readMemberActions(actions, parsed.memberId, options.runtime);
  if (operation === 'lookup') {
    const view = actions.read(parsed.memberId),
      original = actions.lookup((parsed as { originalCommandId: string }).originalCommandId);
    return original && original.input.memberId === parsed.memberId
      ? readMemberActionView(view, original, options.runtime)
      : null;
  }
  const input = parseMemberAction(commandId, raw);
  if (options.isSealed()) throw new RuntimeOwnerError('hold');
  assertCapturedRosterCurrent(team);
  const selected = actions.source(input.memberId);
  const entry = selected.binding ? options.entries.get(runtimeDigest(selected.binding)) : undefined;
  if (entry && (entry.team.owner !== team.owner ||
      runtimeDigest(entry.team.definition.binding) !== runtimeDigest(team.definition.binding) ||
      entry.binding.runId !== input.launchId || entry.profile.memberId !== input.memberId ||
      selected.configurationDigest !== runtimeDigest(entry.profile) ||
      selected.baseConfigurationDigest !== runtimeDigest(entry.baseProfile)))
    throw new RuntimeOwnerError('conflict');
  if (entry) {
    const action = await executeMemberAction(
      {
        entry,
        launch,
        runtime: options.runtime,
        ...(options.modelReadiness ? { modelReadiness: options.modelReadiness } : {}),
        principalId: options.principalId,
        assertWriter: options.assertCurrent,
        isSealed: options.isSealed,
        rekey(before, selected) {
          options.entries.delete(runtimeDigest(before));
          options.entries.set(runtimeDigest(selected.binding), selected);
        },
        assertNewWorkAllowed() {
          team.owner.assertExecutionAllowed(options.principalId);
        },
        verifyNewWorkAllowed: assertRuntimeWorktree,
      },
      operation,
      input.commandId,
      raw,
      readiness
    );
    options.assertCurrent();
    return action
      ? readMemberActionView(actions.read(input.memberId), action, options.runtime)
      : null;
  }
  const revision = team.owner.withLaunchAuthority(options.principalId, 'control', (r) => r);
  const action = executeUnconfiguredSkip(
    {
      actions,
      assertCurrent() {
        options.assertCurrent();
        if (options.isSealed()) throw new RuntimeOwnerError('hold');
        assertCapturedRosterCurrent(team);
        team.owner.withLaunchAuthority(options.principalId, 'control', (r) => {
          if (r !== revision) throw new RuntimeOwnerError('forbidden');
        });
      },
      installSkipped() {
        const member = team.definition.members.find((m) => m.memberId === input.memberId);
        if (!member) throw new RuntimeOwnerError('conflict');
        member.launchPolicy = 'skip';
      },
    },
    operation,
    input
  );
  options.assertCurrent();
  return action
    ? readMemberActionView(actions.read(input.memberId), action, options.runtime)
    : null;
}
