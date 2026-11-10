import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import {
  executeNativeMemberAction,
  parseNativeMemberActionRequest,
} from './executeNativeMemberAction.js';
import type { NativeMemberActionOperation } from './executeNativeMemberAction.js';
import type { NativeMemberActionSource } from './nativeMemberActionAdmission.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
/** Exact retained Team/run; no default/current-launch substitution for native callers. */
export function executeNativeRuntimeMemberAction(
  options: {
    retainedLaunches: ReadonlyMap<string, { team: HostedTeam; launch: TeamLaunchOwner }>;
    entries: Map<string, MemberEntry>;
    runtime: RuntimeOwner;
    assertCurrent(): void;
    isSealed(): boolean;
  },
  source: NativeMemberActionSource,
  teamId: string,
  operation: NativeMemberActionOperation,
  commandId: string,
  raw: unknown
) {
  const input = parseNativeMemberActionRequest(operation, commandId, raw);
  options.assertCurrent();
  const retained = options.retainedLaunches.get(
    runtimeDigest({ teamId, launchId: input.launchId })
  );
  if (
    !retained ||
    source.team.source.teamId !== teamId ||
    retained.team.definition.binding.teamId !== teamId
  )
    throw new RuntimeOwnerError('forbidden');
  return executeNativeMemberAction(
    { ...options, team: retained.team, launch: retained.launch, source },
    operation,
    commandId,
    raw
  );
}
