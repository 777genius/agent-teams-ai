import { RuntimeOwnerError } from '../runtime/contracts.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { resumePreparationSchema } from '../team-launch/launchResume.js';
import { readMemberCheckpoints } from './readMemberCheckpoints.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import type { MemberEntry } from './MemberEntry.js';

/** Prepare all current selections before any dispatch. Checkpoint reads never invoke a provider. */
export function prepareLaunchResume(
  launch: Pick<TeamLaunchOwner, 'prepareResume'>,
  entries: readonly MemberEntry[],
  runtime: Pick<RuntimeOwner, 'readCheckpoints' | 'readSession'>,
  raw: unknown
) {
  const input = resumePreparationSchema.parse(raw);
  const prepared = launch.prepareResume(input, (members) => {
    for (const member of members) {
      const matches = entries.filter(
        (entry) =>
          entry.profile.memberId === member.memberId &&
          entry.binding.generation === member.sourceGeneration
      );
      if (matches.length !== 1) throw new TeamLaunchError('conflict', 'resume-source');
      const observed = readMemberCheckpoints(matches[0]!, runtime);
      if (
        !observed.checkpoints.some(
          (row) => row.reference === member.reference && row.status === 'owner-eligible'
        )
      )
        throw new TeamLaunchError('hold', 'resume-checkpoint-unavailable');
    }
  });
  return { ...prepared, members: prepared.members.map((member) => ({ ...member })) };
}

/** Only a known normalized handler refusal can settle a requested-but-unselected member. */
export function settleLaunchResumeRefusal(
  entry: MemberEntry,
  runtime: Pick<RuntimeOwner, 'readSession'>,
  launch: Pick<TeamLaunchOwner, 'refuseResumeMember'>,
  request: { resumeId?: string; commandId: string; sourceGeneration: string },
  error: unknown
): void {
  if (
    !request.resumeId ||
    !(error instanceof RuntimeOwnerError || error instanceof TeamLaunchError) ||
    !['invalid', 'conflict', 'hold'].includes(error.code)
  )
    return;
  try {
    launch.refuseResumeMember(
      {
        resumeId: request.resumeId,
        commandId: request.commandId,
        code: error.code as 'invalid' | 'conflict' | 'hold',
      },
      () => {
        if (entry.binding.generation !== request.sourceGeneration) return false;
        const observed = runtime.readSession(entry.binding);
        return (
          !observed.attached &&
          observed.record?.phase === 'closed' &&
          observed.record.custody === 'released'
        );
      }
    );
  } catch {
    /* Failure to prove/persist refusal retains the original requested HOLD. */
  }
}
