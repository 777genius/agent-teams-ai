import { MAX_KANBAN_STATE_BYTES } from '@main/services/team/TeamKanbanManager';
import * as fs from 'fs';
import * as path from 'path';

import { inspectTeamReviewFlowState } from '../../core/domain';

import type { ProjectTeamReviewFlow } from '../../contracts/types';
import type { ProjectTeamState, TeamReviewFlowScan } from '../../core/application';

const KANBAN_STATE_FILE = 'kanban-state.json';
const SCAN_CONCURRENCY = 16;

/** The review-flow part of one team's board, or `unavailable` when the board cannot be read. */
export type BoardReviewFlowState =
  | ReturnType<typeof inspectTeamReviewFlowState>
  | { kind: 'unavailable' };

export async function readBoardReviewFlow(
  teamsDir: string,
  teamName: string
): Promise<BoardReviewFlowState> {
  const filePath = path.join(teamsDir, teamName, KANBAN_STATE_FILE);
  let raw: string;
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_KANBAN_STATE_BYTES) return { kind: 'unavailable' };
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    // A board that was never written follows the default, as the controller reads it.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'follows-default' };
    return { kind: 'unavailable' };
  }
  try {
    return inspectTeamReviewFlowState(JSON.parse(raw));
  } catch {
    // A file that is not even JSON is broader damage than a review-flow override can repair.
    return { kind: 'unavailable' };
  }
}

function toProjectTeamReviewFlow(
  team: ProjectTeamState | undefined
): ProjectTeamReviewFlow | undefined {
  if (!team) return undefined;
  const { saved } = team;
  return {
    saved: saved !== undefined,
    settings: saved === undefined || saved === 'unreadable' ? null : saved,
    ...(saved === 'unreadable' ? { unreadable: true as const } : {}),
    projects: team.projects.map(({ executionTeamName, projectPath }) => ({
      executionTeamName,
      projectPath,
    })),
  };
}

/**
 * Finds teams that carry their own review flow, and teams whose saved review-flow fields are
 * invalid (the controller refuses to run those until the override is reset). Bounded parallel reads.
 * `readProjectTeam` adds each team that keeps separate history per project, with its projects.
 */
export async function scanTeamReviewFlowOverrides(
  teamsDir: string,
  readProjectTeam: (teamName: string) => Promise<ProjectTeamState | undefined>
): Promise<TeamReviewFlowScan> {
  const scan: TeamReviewFlowScan = { overrides: {}, unreadable: [], projectTeams: {} };
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(teamsDir, { withFileTypes: true });
  } catch {
    return scan;
  }
  const teamNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const unavailable = new Set<string>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < teamNames.length) {
      const teamName = teamNames[next++];
      const [result, projectTeam] = await Promise.all([
        readBoardReviewFlow(teamsDir, teamName),
        // A team whose projects cannot be read is listed with the reason, never shown as the default.
        readProjectTeam(teamName).then(toProjectTeamReviewFlow, (error: unknown) => ({
          saved: false,
          settings: null,
          projects: [],
          projectsError: error instanceof Error ? error.message : String(error),
        })),
      ]);
      if (result.kind === 'override') scan.overrides[teamName] = result.settings;
      else if (result.kind === 'invalid') scan.unreadable.push(teamName);
      else if (result.kind === 'unavailable') unavailable.add(teamName);
      if (projectTeam) scan.projectTeams[teamName] = projectTeam;
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, teamNames.length) }, worker));
  // Unavailable copies must not be mistaken for boards following the default.
  for (const team of Object.values(scan.projectTeams)) {
    for (const project of team.projects) {
      if (unavailable.has(project.executionTeamName)) scan.unreadable.push(project.executionTeamName);
    }
  }
  scan.unreadable.sort();
  return scan;
}
