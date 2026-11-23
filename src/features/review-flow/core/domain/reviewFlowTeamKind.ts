/**
 * What a team name means for its review flow: an ordinary board, a team with separate history per
 * project (one setting for the team), or the project copy of such a team (it has none of its own).
 */
export type ReviewFlowTeamKind = 'board' | 'project-team' | 'project-copy';

/**
 * The review-flow meaning of a classified team name (`logical`, `alias`, `native`, as the
 * project-context feature classifies it). A project copy follows its team only when that team keeps
 * separate history per project; a copy that an ordinary team kept from an earlier period is still a
 * board of its own.
 */
export function reviewFlowTeamKindOf(
  kind: 'logical' | 'alias' | 'native',
  ownerKeepsHistoryPerProject: boolean
): ReviewFlowTeamKind {
  if (kind === 'logical') return 'project-team';
  return kind === 'alias' && ownerKeepsHistoryPerProject ? 'project-copy' : 'board';
}
