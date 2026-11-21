import { MAX_KANBAN_STATE_BYTES } from '@main/services/team/TeamKanbanManager';
import * as fs from 'fs';
import * as path from 'path';

import { inspectTeamReviewFlowState } from '../../core/domain';

import type { TeamReviewFlowScan } from '../../core/application';

const KANBAN_STATE_FILE = 'kanban-state.json';
const SCAN_CONCURRENCY = 16;

type TeamScanResult = ReturnType<typeof inspectTeamReviewFlowState> | { kind: 'unavailable' };

async function inspectTeam(teamsDir: string, teamName: string): Promise<TeamScanResult> {
  const filePath = path.join(teamsDir, teamName, KANBAN_STATE_FILE);
  let raw: string;
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_KANBAN_STATE_BYTES) return { kind: 'unavailable' };
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return { kind: 'unavailable' };
  }
  try {
    return inspectTeamReviewFlowState(JSON.parse(raw));
  } catch {
    // A file that is not even JSON is broader damage than a review-flow override can repair.
    return { kind: 'unavailable' };
  }
}

/**
 * Finds teams that carry their own review flow, and teams whose saved review-flow fields are
 * invalid (the controller refuses to run those until the override is reset). Bounded parallel reads.
 */
export async function scanTeamReviewFlowOverrides(teamsDir: string): Promise<TeamReviewFlowScan> {
  const scan: TeamReviewFlowScan = { overrides: {}, unreadable: [] };
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(teamsDir, { withFileTypes: true });
  } catch {
    return scan;
  }
  const teamNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < teamNames.length) {
      const teamName = teamNames[next++];
      const result = await inspectTeam(teamsDir, teamName);
      if (result.kind === 'override') scan.overrides[teamName] = result.settings;
      else if (result.kind === 'invalid') scan.unreadable.push(teamName);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, teamNames.length) }, worker));
  scan.unreadable.sort();
  return scan;
}
