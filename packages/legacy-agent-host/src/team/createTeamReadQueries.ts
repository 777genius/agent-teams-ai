import { digest, safeSegment } from "./identity.js";
import { TeamOwnerError } from "./contracts.js";
import type { TeamGrant, TeamMember } from "./contracts.js";
import type { TeamBoardReadPolicy, TeamTaskInventoryFilters } from "./ports.js";

/** Read-only policy binding. No writer, native callback or path selector is exposed. */
export function createTeamReadQueries(options: {
  reads: TeamBoardReadPolicy;
  fenced<T>(action: () => T): T;
  authority(): { grant: TeamGrant; members: readonly TeamMember[] };
  getTeam(): unknown;
}) {
  const identity = () => {
    const { grant, members } = options.authority();
    return {
      grant,
      members,
      fingerprint: digest({ grant, members }),
    };
  };
  const read = <T>(action: () => T): T =>
    options.fenced(() => {
      identity();
      return action();
    });
  const briefing = async (memberName?: string): Promise<string> => {
    const pending = options.fenced(() => {
      const original = identity();
      if (memberName === undefined) {
        return {
          fingerprint: original.fingerprint,
          value: options.reads.leadBriefing(),
        };
      }
      safeSegment(memberName);
      if (!original.members.some((member) => member.name === memberName))
        throw new TeamOwnerError("invalid");
      return {
        fingerprint: original.fingerprint,
        value: options.reads.taskBriefing(memberName),
      };
    });
    const value = await pending.value;
    return options.fenced(() => {
      if (identity().fingerprint !== pending.fingerprint)
        throw new TeamOwnerError("forbidden");
      return value;
    });
  };
  return Object.freeze({
    getTeam: () => read(options.getTeam),
    getKanbanState: (settings?: { strict?: boolean }) => read(() => options.reads.getKanbanState(settings)),
    listReviewers: () => read(() => options.reads.listReviewers()),
    getTaskComment: (taskId: string, commentId: string) =>
      read(() => {
        safeSegment(taskId);
        safeSegment(commentId);
        return options.reads.getTaskComment(taskId, commentId);
      }),
    listTaskInventory: (filters: TeamTaskInventoryFilters) =>
      read(() => options.reads.listTaskInventory(filters)),
    taskBriefing: (memberName?: string) => {
      const selected = read(() => memberName ?? identity().grant.memberName);
      return briefing(selected);
    },
    leadBriefing: () => briefing(),
    ...(options.reads.memberBriefing
      ? {
          memberBriefing: async (settings: { includeActiveProcesses: boolean }) => {
            const pending = options.fenced(() => {
              const original = identity();
              const memberName = original.grant.memberName;
              if (!original.members.some((member) => member.name === memberName))
                throw new TeamOwnerError('forbidden');
              return {
                fingerprint: original.fingerprint,
                value: options.reads.memberBriefing!(memberName, settings),
              };
            });
            const value = await pending.value;
            return options.fenced(() => {
              if (identity().fingerprint !== pending.fingerprint)
                throw new TeamOwnerError('forbidden');
              return value;
            });
          },
        }
      : {}),
  });
}
