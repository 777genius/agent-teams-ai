/**
 * The teams directory is shared by every copy of this app on the machine, by e2e
 * runs and by native Claude Code sessions. Transcript lookups may read any team,
 * but they write under a team directory (its transcript index, a repaired
 * projectPath in config.json) only when this policy says the team may be written.
 * Every place that builds such a lookup decides it explicitly: the main process
 * asks whether the team is managed by this app profile, worker threads and
 * standalone defaults never write.
 */
export type TeamFileWritePolicy = (teamName: string) => Promise<boolean>;

/** Anything but an explicit yes, including a policy that throws or rejects, means read only. */
export async function mayWriteTeamFiles(
  policy: TeamFileWritePolicy,
  teamName: string
): Promise<boolean> {
  try {
    return (await policy(teamName)) === true;
  } catch {
    return false;
  }
}
