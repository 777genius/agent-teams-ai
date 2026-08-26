import * as fs from 'fs';

const MAX_RECOVERY_TEAMS_PER_PASS = 16;
const MAX_RECOVERY_PASS_MS = 25;
const startupCursorByRoot = new Map<string, string | null>();

export async function recoverAllRosterAuthorizationTeams(input: {
  teamsBasePath: string;
  recoverTeam(teamName: string): Promise<void>;
  scheduleTeamRetry(teamName: string): void;
  scheduleStartupScanRetry(): void;
  now?: () => number;
}): Promise<void> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(input.teamsBasePath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    input.scheduleStartupScanRetry();
    throw error;
  }
  const cursor = startupCursorByRoot.get(input.teamsBasePath) ?? null;
  const teams = entries
    .filter((entry) => entry.isDirectory() && (cursor === null || entry.name > cursor))
    .map((entry) => entry.name)
    .sort();
  let processed = 0;
  for (const teamName of teams) {
    if (
      processed >= MAX_RECOVERY_TEAMS_PER_PASS ||
      (processed > 0 && now() - startedAt >= MAX_RECOVERY_PASS_MS)
    ) {
      startupCursorByRoot.set(input.teamsBasePath, teams[processed - 1] ?? cursor);
      input.scheduleStartupScanRetry();
      return;
    }
    await input.recoverTeam(teamName).catch(() => input.scheduleTeamRetry(teamName));
    processed += 1;
  }
  startupCursorByRoot.delete(input.teamsBasePath);
}
