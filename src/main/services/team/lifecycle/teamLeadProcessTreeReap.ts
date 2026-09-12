import { getTeamsBasePath } from '@main/utils/pathDecoder';

import {
  type AttributedCursorAgentProcess,
  type CursorAgentAttributionOwner,
  type CursorAgentAttributionPort,
  type CursorAgentAttributionRecord,
  DEFAULT_CURSOR_AGENT_ATTRIBUTION_PORT,
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
 * branch here narrows it. The stop reaps only trees whose workspace is this
 * team's own project path, so a project path this app cannot read means no reap
 * at all rather than a wider one. A still-running team working in the same
 * directory owns lead trees that carry exactly the same `--workspace`, and
 * nothing tells those two apart, so that case is a skip as well. The time fence
 * is the last one: it is the moment the stop was requested, so a relaunch of
 * this team started inside the stop window keeps the tree it just created.
 *
 * What the runtime recorded about the processes it spawned is now the first
 * question, ahead of all of them. A record names the pid, the start time and
 * the exact `--workspace` from inside the spawned process, and its host names
 * the teams that host holds leases for - so this stop can ask whether a tree is
 * ITS tree instead of whether a command line could be read as its own. A tree no
 * record names is still only reachable through the command-line path an operator
 * has to turn on, which is exactly where that path was before.
 */
export async function reapCursorAgentLeadTreesForStoppedTeam(input: {
  teamName: string;
  otherAliveTeams: readonly string[];
  requestedAtMs?: number;
  cursorAgentTreeSweep?: CursorAgentTreeSweepPort;
  cursorAgentAttribution?: CursorAgentAttributionPort;
}): Promise<{ killedPids: number[]; incomplete: boolean; diagnostics: string[] }> {
  const attributionPort = input.cursorAgentAttribution ?? DEFAULT_CURSOR_AGENT_ATTRIBUTION_PORT;
  const attributed = await attributionPort.readAttributedProcesses();
  // The records this stop is allowed to decide on, and the count of the ones it
  // could actually reap. A runtime that writes none leaves both empty, which is
  // how every branch below stays exactly what it is today.
  const usableRecords = selectRecordsThisStopMayUse(attributed, input.teamName);
  const reapableRecords = usableRecords.filter((record) => record.kind === 'cursor-agent').length;
  const attributionNotes =
    attributed.length === 0
      ? []
      : [
          `cursor-agent attribution: ${attributed.length} runtime process record(s) available, ` +
            `${reapableRecords} this stop may reap`,
        ];

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
  if (confusableWith.length > 0 && reapableRecords === 0) {
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
    //
    // A record settles that ambiguity outright, because the workspace in it is
    // the argument the spawned process was given rather than a substring of a
    // joined line - so with a record in hand the stop goes on, and reaps
    // nothing the record does not name.
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

  // The command-line path an operator turned on, and never where a confusable
  // neighbour is live: there the record is the only thing that may decide, and
  // widening back to the command line would reap exactly the tree the veto
  // above exists to spare.
  const allowUnattributedReap = confusableWith.length === 0 && sweepPort.allowsUnattributedReap();
  if (reapableRecords === 0 && !allowUnattributedReap) {
    // Nothing to prove and nothing allowed to be assumed, so the process table
    // is not read at all - the decision this stop made before records existed,
    // taken for the same reason.
    return {
      killedPids: [],
      incomplete: false,
      diagnostics: [
        ...attributionNotes,
        'Skipped cursor-agent sweep: no runtime record names a tree of this team, and reaping an unattributed tree on its command line alone is off',
      ],
    };
  }

  const sweep = await sweepPort.sweepCursorAgentTrees({
    ownedWorkspaceCwds: [workspace],
    startedBeforeMs: input.requestedAtMs ?? Date.now(),
    // Identity written by the spawned process itself, filtered to the records
    // whose host holds no lease for any OTHER team.
    attributedProcesses: usableRecords,
    // Asked again in the moment before a proven tree is signalled, from the
    // records as they are THEN. The selection above is a snapshot, and between
    // it and the kill this stop reads workspaces, a process table and start
    // times - long enough for another team to start on the same host and take
    // a lease the snapshot never saw. A record that no longer selects keeps its
    // tree; the sweep reports why.
    reconfirmAttribution: async (record) =>
      selectRecordsThisStopMayUse(
        await attributionPort.readAttributedProcesses(),
        input.teamName
      ).some(
        (fresh) =>
          fresh.attributionId === record.attributionId &&
          fresh.pid === record.pid &&
          fresh.startedAtMs === record.startedAtMs
      ),
    requireAttributionProof: reapableRecords > 0,
    allowUnattributedReap,
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
  if (confusableWith.length > 0) {
    diagnostics.push(
      'cursor-agent sweep: a still-running team works in a directory whose command line cannot ' +
        `be told apart from this team's (${confusableWith.join(', ')}), so only a tree the ` +
        'runtime recorded for this team is reaped'
    );
  }
  if (sweep.killed.length > 0) {
    diagnostics.push(`Reaped ${sweep.killed.length} cursor-agent process tree(s)`);
  }
  diagnostics.push(...sweep.diagnostics.map((entry) => `cursor-agent sweep: ${entry}`));
  return { killedPids: sweep.killed, incomplete: sweep.incomplete, diagnostics };
}

/**
 * The records a stop of this team is allowed to put in front of the sweep.
 *
 * One question about the host's lease set, which is what the record joins to:
 * is every lease the recorded host holds this team's own? The set is what the
 * host holds NOW - the runtime removes a lease from it the moment the lease is
 * released - so a name in it that is not this team's is a live claim on the
 * host, whatever the caller's list of running teams says about that team, and
 * stopping one of a shared host's teams says nothing about the rest. An owner
 * this app cannot even name is a veto for the same reason: a lease it cannot
 * read is not a lease it can clear.
 *
 * A validated host with an explicitly empty lease set is the exception. Its
 * record is passed on, and the exact workspace, live start time and shared-
 * directory veto still decide whether it may be reaped. A missing, unreadable
 * or rejected host yields an unnamed owner from the reader and is vetoed; it
 * is not evidence that the host released its last lease.
 *
 * A readiness probe is passed on deliberately although nothing may reap it: the
 * sweep needs the record in hand to recognise the runtime's own probe tree and
 * decline it by name instead of by timing.
 */
function selectRecordsThisStopMayUse(
  attributed: readonly AttributedCursorAgentProcess[],
  teamName: string
): readonly CursorAgentAttributionRecord[] {
  return attributed
    .filter(
      (entry) =>
        entry.record.kind === 'readiness-probe' ||
        entry.owners.map(readOwnerTeam).every((ownerTeam) => ownerTeam === teamName)
    )
    .map((entry) => entry.record);
}

/**
 * The team an owner entry names, in the field the writer used.
 *
 * The lease set is written by the runtime, which carries ONE team field per
 * owner - `teamId` - and this app is what fills it, with the team NAME it
 * launched under. `teamName` is the second spelling of the same thing. A writer
 * that supplies both has to agree with itself: an entry naming one team in one
 * field and another in the other is not "the first one", it is an owner this
 * app cannot name - and, above, a claim it cannot clear.
 */
function readOwnerTeam(owner: CursorAgentAttributionOwner): string | null {
  const teamName = owner.teamName?.trim() || null;
  const teamId = owner.teamId?.trim() || null;
  if (teamName !== null && teamId !== null && teamName !== teamId) return null;
  return teamName ?? teamId;
}
