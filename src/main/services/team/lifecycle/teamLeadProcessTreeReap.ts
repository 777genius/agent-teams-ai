import { getTeamsBasePath } from '@main/utils/pathDecoder';

import {
  type CursorAgentAttributionPort,
  DEFAULT_CURSOR_AGENT_ATTRIBUTION_PORT,
  summarizeAttributedCursorAgentProcesses,
} from '../opencode/bridge/CursorAgentAttributionRecords';
import {
  CURSOR_AGENT_APP_OWNERSHIP_ENV_MARKER,
  type CursorAgentTreeSweepPort,
  DEFAULT_CURSOR_AGENT_TREE_SWEEP_PORT,
  isConfusableWorkspacePath,
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
  cursorAgentAttribution?: CursorAgentAttributionPort;
}): Promise<{ killedPids: number[]; incomplete: boolean; diagnostics: string[] }> {
  // Read, reported, and not yet acted upon. The proof path that turns a record
  // into permission to reap needs a runtime that writes one, and until this app
  // pins such a runtime the only honest thing a stop can do with a record is
  // say it saw it - which is also how an operator finds out whether the runtime
  // in front of them writes records at all. Every branch below decides exactly
  // what it decides today.
  const attributionNotes = await describeAttributedCursorAgentProcesses(
    input.cursorAgentAttribution
  );

  const sweepPort = input.cursorAgentTreeSweep ?? DEFAULT_CURSOR_AGENT_TREE_SWEEP_PORT;
  if (!sweepPort.isEnabled()) {
    return {
      killedPids: [],
      incomplete: false,
      diagnostics: [
        ...attributionNotes,
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
        ...attributionNotes,
        'Skipped cursor-agent sweep: this team has no readable project path, and a lead tree is only reaped for a workspace this stop can name',
      ],
    };
  }

  const sharedWith: string[] = [];
  const confusableWith: string[] = [];
  for (const otherTeam of input.otherAliveTeams) {
    const otherWorkspace = await readTeamProjectWorkspace(teamsBasePath, otherTeam);
    if (!otherWorkspace) continue;
    if (isSameWorkspacePath(otherWorkspace, workspace)) {
      sharedWith.push(otherTeam);
    } else if (isConfusableWorkspacePath(otherWorkspace, workspace)) {
      confusableWith.push(otherTeam);
    }
  }
  if (confusableWith.length > 0) {
    // The independent proof this sweep otherwise lacks.
    //
    // A process table gives a JOINED command line, so `--workspace /work/app -
    // backup` cannot be told apart from `--workspace /work/app` followed by
    // arguments. No parsing rule recovers the argv boundaries, which means a
    // stop of `/work/app` could reach the tree of a live team working in
    // `/work/app - backup`.
    //
    // What the caller does know is which teams are still running and where.
    // When one of them sits in a directory whose spelling could be read as
    // this team's plus arguments, the ambiguity is not hypothetical - it is
    // present right now, on this machine - and the sweep declines rather than
    // resolving it by guesswork.
    return {
      killedPids: [],
      incomplete: false,
      diagnostics: [
        ...attributionNotes,
        'Skipped cursor-agent sweep: a still-running team works in a directory whose command ' +
          `line cannot be told apart from this team's (${confusableWith.join(', ')})`,
      ],
    };
  }
  if (sharedWith.length > 0) {
    return {
      killedPids: [],
      incomplete: false,
      diagnostics: [
        ...attributionNotes,
        `Skipped cursor-agent sweep: still-running team(s) work in the same project directory (${sharedWith.join(', ')})`,
      ],
    };
  }

  const sweep = await sweepPort.sweepCursorAgentTrees({
    ownedWorkspaceCwds: [workspace],
    startedBeforeMs: input.requestedAtMs ?? Date.now(),
    // The env marker separates this app's lead from a `cursor-agent --print` the
    // user is running themselves in the same directory - the one case the
    // workspace fence above cannot see.
    requiredEnvMarkers: [CURSOR_AGENT_APP_OWNERSHIP_ENV_MARKER],
    // Softer than the startup sweep on purpose, in both fences.
    //
    // Ownership is not required here because the caller has already proven far
    // more than the environment could add: this exact team was just stopped by
    // this user, its project path was read from this app's own team config, and
    // every other live team sharing that directory has already vetoed the sweep
    // above. Refusing on an unreadable environment would leave the tree holding
    // the proxy port that the next launch has to bind, which is the whole reason
    // the stop reaps it.
    //
    // The orphan fence is wrong here for a different reason: the team's own
    // serve host may still be shutting down beside the lead it owns, so the lead
    // still has a live parent at this moment and would be spared for being
    // exactly what it is.
    requireOwnershipProof: false,
    orphanedOnly: false,
  });
  const diagnostics = [...attributionNotes];
  if (sweep.killed.length > 0) {
    diagnostics.push(`Reaped ${sweep.killed.length} cursor-agent process tree(s)`);
  }
  diagnostics.push(...sweep.diagnostics.map((entry) => `cursor-agent sweep: ${entry}`));
  return { killedPids: sweep.killed, incomplete: sweep.incomplete, diagnostics };
}

/**
 * One line when the runtime has recorded processes for this install, and
 * nothing at all when it has not - a stop against a runtime that writes no
 * records reads exactly as it does today. The reader never throws, so an
 * unreadable record directory is already the empty answer.
 */
async function describeAttributedCursorAgentProcesses(
  port: CursorAgentAttributionPort | undefined
): Promise<string[]> {
  const attributed = await (
    port ?? DEFAULT_CURSOR_AGENT_ATTRIBUTION_PORT
  ).readAttributedProcesses();
  const { total, withRecordedOwner } = summarizeAttributedCursorAgentProcesses(attributed);
  if (total === 0) return [];
  return [
    `cursor-agent attribution: ${total} runtime process record(s) available, ${withRecordedOwner} with a recorded owner; this stop still decides on the command line`,
  ];
}
