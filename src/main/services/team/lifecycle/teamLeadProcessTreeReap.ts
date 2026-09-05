import { getTeamsBasePath } from '@main/utils/pathDecoder';

import {
  type CursorAgentTreeSweepPort,
  DEFAULT_CURSOR_AGENT_TREE_SWEEP_PORT,
  isSameWorkspacePath,
} from '../opencode/bridge/CursorAgentProcessCleanup';
import { readTeamProjectWorkspace } from '../TeamProjectWorkspaces';

/**
 * Ends the external `cursor-agent` lead trees a stopped cursor-acp team leaves
 * behind. They are not registered hosts, so nothing else in this flow reaches
 * them, and what survives keeps calling the MCP server for a team that no
 * longer exists while holding the cursor proxy port the next cursor-acp launch
 * has to bind.
 *
 * Scope is the whole question, because the sweep kills whole trees, and every
 * branch here narrows it. The stop reaps only trees whose command line names
 * this team's own project path, so a project path this app cannot read means no
 * reap at all rather than a wider one. A still-running team working in the same
 * directory owns lead trees that carry exactly the same `--workspace`, and
 * nothing on a command line tells those two apart, so that case is a skip as
 * well. The time fence is the last one: it is the moment the stop was requested,
 * so a relaunch of this team started inside the stop window keeps the tree it
 * just created.
 */
export async function reapCursorAgentLeadTreesForStoppedTeam(input: {
  teamName: string;
  otherAliveTeams: readonly string[];
  requestedAtMs?: number;
  cursorAgentTreeSweep?: CursorAgentTreeSweepPort;
}): Promise<{ killedPids: number[]; incomplete: boolean; diagnostics: string[] }> {
  const sweepPort = input.cursorAgentTreeSweep ?? DEFAULT_CURSOR_AGENT_TREE_SWEEP_PORT;
  if (!sweepPort.isEnabled()) {
    return {
      killedPids: [],
      incomplete: false,
      diagnostics: [
        'Skipped cursor-agent sweep: the cursor-agent tree sweep is disabled for this app instance',
      ],
    };
  }

  const teamsBasePath = getTeamsBasePath();
  const workspace = await readTeamProjectWorkspace(teamsBasePath, input.teamName);
  if (!workspace) {
    return {
      killedPids: [],
      incomplete: false,
      diagnostics: [
        'Skipped cursor-agent sweep: this team has no readable project path, and a lead tree is only reaped for a workspace this stop can name',
      ],
    };
  }

  const sharedWith: string[] = [];
  for (const otherTeam of input.otherAliveTeams) {
    const otherWorkspace = await readTeamProjectWorkspace(teamsBasePath, otherTeam);
    if (otherWorkspace && isSameWorkspacePath(otherWorkspace, workspace)) {
      sharedWith.push(otherTeam);
    }
  }
  if (sharedWith.length > 0) {
    return {
      killedPids: [],
      incomplete: false,
      diagnostics: [
        `Skipped cursor-agent sweep: still-running team(s) work in the same project directory (${sharedWith.join(', ')})`,
      ],
    };
  }

  const sweep = await sweepPort.sweepCursorAgentTrees({
    ownedWorkspaceCwds: [workspace],
    startedBeforeMs: input.requestedAtMs ?? Date.now(),
  });
  const diagnostics =
    sweep.killed.length > 0 ? [`Reaped ${sweep.killed.length} cursor-agent process tree(s)`] : [];
  diagnostics.push(...sweep.diagnostics.map((entry) => `cursor-agent sweep: ${entry}`));
  return { killedPids: sweep.killed, incomplete: sweep.incomplete, diagnostics };
}
