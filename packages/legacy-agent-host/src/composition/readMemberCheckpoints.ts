import { TeamOwnerError } from '../team/contracts.js';
import { assertCapturedRosterCurrent } from './teamRoster.js';
import type { CheckpointAvailability } from '../runtime/checkpointContracts.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { MemberEntry } from './MemberEntry.js';

/** Safe, current app selection only. Native backing remains unverified until explicit restore. */
export function readMemberCheckpoints(
  entry: MemberEntry,
  runtime: Pick<RuntimeOwner, 'readCheckpoints' | 'readSession'>
): CheckpointAvailability & { memberId: string } {
  const unavailable = (reason: CheckpointAvailability['reason']) => ({
    memberId: entry.profile.memberId,
    sourceGeneration: entry.binding.generation,
    status: 'unavailable' as const,
    reason,
    nativeBacking: 'unverified' as const,
    checkpoints: [],
  });
  try {
    assertCapturedRosterCurrent(entry.team);
  } catch (error) {
    if (error instanceof TeamOwnerError && error.code === 'hold')
      return unavailable('configuration-changed');
    throw error;
  }
  if (runtime.readSession(entry.binding).attached) return unavailable('custody-unreleased');
  if (!Number.isSafeInteger(entry.profile.generation + 1))
    return unavailable('generation-conflict');
  return {
    memberId: entry.profile.memberId,
    ...runtime.readCheckpoints(entry.binding, {
      ...entry.config,
      generation: entry.profile.generation + 1,
    }),
  };
}
