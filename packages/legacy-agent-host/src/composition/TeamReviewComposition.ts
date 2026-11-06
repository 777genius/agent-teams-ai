import { readProcessStartTimeMs } from '@agent-teams/task-change-ledger/review-storage';
import { createTeamReviewMethods } from '../review/createTeamReviewMethods.js';
import { TeamOwnerError } from '../team/contracts.js';
import { createHostTeamReview } from './HostTeamReview.js';
import type { HostedTeam } from './MemberEntry.js';
import type { TeamHostProfile } from './TeamHost.js';

type Selected = { team: HostedTeam; commandId: string; payload: unknown };
/** Captures one project/owner instance; a later project cannot borrow its tokens or pending work. */
export function createTeamReviewComposition(options: {
  profile: TeamHostProfile;
  select(raw: unknown): Selected;
  assertCurrent(): void;
}) {
  const services = new Map<
    string,
    {
      team: HostedTeam;
      review: ReturnType<typeof createHostTeamReview>;
    }
  >();
  let sealed = false;
  const assertCurrent = () => {
    if (sealed) throw new TeamOwnerError('hold');
    options.assertCurrent();
  };
  const workspace = (team: HostedTeam): string | undefined => {
    const roster = team.connection.readRoster();
    const lead = roster.members.find((member) => member.role === 'lead');
    const cwd =
      roster.savedSettings?.cwd ??
      options.profile.runtime?.members.find(
        (member) =>
          member.teamId === team.definition.binding.teamId && member.memberId === lead?.memberId
      )?.cwd;
    return cwd;
  };
  const methods = options.profile.reviewTransport
    ? createTeamReviewMethods({
        select(raw) {
          assertCurrent();
          const selected = options.select(raw);
          const teamId = selected.team.definition.binding.teamId;
          let entry = services.get(teamId);
          if (entry && entry.team !== selected.team) {
            entry.review.dispose();
            services.delete(teamId);
            entry = undefined;
          }
          if (!entry) {
            const team = selected.team;
            let capturedReview: ReturnType<typeof createHostTeamReview> | undefined;
            const review = createHostTeamReview({
              team,
              principalId: options.profile.principalId,
              ownerStorageRoot: options.profile.owner.storageRoot,
              currentProjectPath: () => workspace(team),
              ...(options.profile.runtime ? { initialRuntimeMembers: options.profile.runtime.members } : {}),
              processStartProbe: readProcessStartTimeMs,
              assertCurrent() {
                assertCurrent();
                const current = services.get(teamId);
                // Constructor runs before publication; an existing different service is never borrowed.
                if (current && current.review !== capturedReview) throw new TeamOwnerError('hold');
              },
            });
            capturedReview = review;
            entry = { team, review };
            services.set(teamId, entry);
          }
          return { commandId: selected.commandId, payload: selected.payload, review: entry.review };
        },
      })
    : {};
  return {
    methods,
    seal() {
      if (sealed) return;
      sealed = true;
      for (const entry of services.values()) entry.review.dispose();
      services.clear();
    },
  };
}
