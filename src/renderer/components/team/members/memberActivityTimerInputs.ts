import {
  deriveReviewActivityTimerAnchor,
  deriveWorkActivityTimerAnchor,
} from '@renderer/utils/memberActivityTimer';
import { shouldDisplayMemberCurrentTask } from '@renderer/utils/memberHelpers';
import { isDisplayableCurrentTask } from '@renderer/utils/teamTaskDisplayState';

import type {
  MemberSpawnStatusEntry,
  ResolvedTeamMember,
  TeamAgentRuntimeEntry,
  TeamTaskWithKanban,
} from '@shared/types';

// The argument `syncMemberActivityTimer` accepts. Written out because this repo's lint requires an
// interface for object shapes; drift is caught by the compiler, since the caller hands these objects
// to that function and a new required field fails the type check at the call site.
export interface MemberActivityTimerSyncInput {
  timerId: string;
  startedAtMs: number;
  baseElapsedMs?: number;
  running: boolean;
  runId?: string | null;
  nowMs?: number;
}

export interface MemberActivityTimerSyncContext {
  nowMs: number;
  teamName: string;
  taskMap?: Map<string, TeamTaskWithKanban>;
  activeMembers: ResolvedTeamMember[];
  memberSpawnStatuses?: Map<string, MemberSpawnStatusEntry>;
  runtimeEntries?: Map<string, TeamAgentRuntimeEntry>;
  reviewTaskByMember: Map<string, TeamTaskWithKanban>;
  isTeamAlive?: boolean;
  isMemberRunning: (
    member: ResolvedTeamMember,
    spawnEntry: MemberSpawnStatusEntry | undefined,
    runtimeEntry: TeamAgentRuntimeEntry | undefined
  ) => boolean;
  runIdFor: (running: boolean) => string | null;
}

// One pass over the roster builds every activity timer this frame owns, as the exact argument objects
// the caller will write. The list exists so the caller can declare the whole set before it writes the
// first member: retention reclamation runs inside that first write, and an anchor that has not been
// written yet is on disk, is not resident and has not been read — so nothing in the store can tell it
// from a dead key. Living in this file rather than in `MemberList` is that component's frozen line
// budget, not a layering preference.
export function collectMemberActivityTimerSyncInputs({
  nowMs,
  teamName,
  taskMap,
  activeMembers,
  memberSpawnStatuses,
  runtimeEntries,
  reviewTaskByMember,
  isTeamAlive,
  isMemberRunning,
  runIdFor,
}: MemberActivityTimerSyncContext): MemberActivityTimerSyncInput[] {
  if (!taskMap) return [];
  const inputs: MemberActivityTimerSyncInput[] = [];
  for (const member of activeMembers) {
    const spawnEntry = memberSpawnStatuses?.get(member.name);
    const runtimeEntry = runtimeEntries?.get(member.name);
    const running = isMemberRunning(member, spawnEntry, runtimeEntry);
    const currentTaskCandidate = member.currentTaskId
      ? (taskMap.get(member.currentTaskId) ?? null)
      : null;
    if (isDisplayableCurrentTask(currentTaskCandidate)) {
      const anchor = deriveWorkActivityTimerAnchor(currentTaskCandidate, {
        teamName,
        memberName: member.name,
      });
      if (anchor) {
        const visible =
          running &&
          shouldDisplayMemberCurrentTask({
            member,
            isTeamAlive,
            spawnStatus: spawnEntry?.status,
            spawnLaunchState: spawnEntry?.launchState,
            spawnRuntimeAlive: spawnEntry?.runtimeAlive,
            spawnEntry,
            runtimeEntry,
          });
        inputs.push({
          timerId: anchor.timerId,
          startedAtMs: anchor.startedAtMs,
          baseElapsedMs: anchor.baseElapsedMs,
          running: visible,
          runId: runIdFor(visible),
          nowMs,
        });
      }
    }

    const reviewTask = reviewTaskByMember.get(member.name) ?? null;
    if (reviewTask) {
      const anchor = deriveReviewActivityTimerAnchor(reviewTask, {
        teamName,
        memberName: member.name,
      });
      if (anchor) {
        inputs.push({
          timerId: anchor.timerId,
          startedAtMs: anchor.startedAtMs,
          baseElapsedMs: anchor.baseElapsedMs,
          running,
          runId: runIdFor(running),
          nowMs,
        });
      }
    }
  }
  return inputs;
}

// The ids only, derived by the same pass the writer uses with placeholder payloads that are then
// discarded — so the set a frame declares cannot drift from the set it writes. That matters because a
// declared id that never gets written is not protected by anything else: the declaration exists for
// the case where a passive effect is about to write a key no render has read.
export function collectMemberActivityTimerIds(
  context: Pick<
    MemberActivityTimerSyncContext,
    'activeMembers' | 'reviewTaskByMember' | 'taskMap' | 'teamName'
  >
): string[] {
  return collectMemberActivityTimerSyncInputs({
    ...context,
    nowMs: 0,
    isTeamAlive: undefined,
    memberSpawnStatuses: undefined,
    runtimeEntries: undefined,
    isMemberRunning: () => false,
    runIdFor: () => '',
  }).map((input) => input.timerId);
}
