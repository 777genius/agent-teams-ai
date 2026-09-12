import { getTeamsBasePath } from '@main/utils/pathDecoder';

import {
  type CursorAgentAtomicReapPort,
  DEFAULT_CURSOR_AGENT_ATOMIC_REAP_PORT,
} from '../opencode/bridge/CursorAgentAtomicReapBridge';
import {
  type CursorAgentAttributionPort,
  DEFAULT_CURSOR_AGENT_ATTRIBUTION_PORT,
} from '../opencode/bridge/CursorAgentAttributionRecords';
import { readTeamProjectWorkspace } from '../TeamProjectWorkspaces';

/** The runtime checks authoritative leases under its shared lock before reaping. */
export async function reapCursorAgentLeadTreesForStoppedTeam(input: {
  teamName: string;
  otherAliveTeams: readonly string[];
  requestedAtMs?: number;
  cursorAgentAtomicReap?: CursorAgentAtomicReapPort;
  cursorAgentAttribution?: CursorAgentAttributionPort;
}): Promise<{ killedPids: number[]; incomplete: boolean; diagnostics: string[] }> {
  const startedBeforeMs = input.requestedAtMs ?? Date.now();
  const diagnostics: string[] = [];
  try {
    const workspace = await readTeamProjectWorkspace(getTeamsBasePath(), input.teamName);
    if (!workspace) {
      return {
        killedPids: [],
        incomplete: false,
        diagnostics: ['Skipped cursor-agent reap: this team has no readable project path'],
      };
    }
    const attributed = await (
      input.cursorAgentAttribution ?? DEFAULT_CURSOR_AGENT_ATTRIBUTION_PORT
    ).readAttributedProcesses();
    const cursorAgentCount = attributed.filter(
      (entry) => entry.record.kind === 'cursor-agent'
    ).length;
    if (attributed.length > 0) {
      diagnostics.push(
        `cursor-agent attribution: ${attributed.length} runtime process record(s) available, ` +
          `${cursorAgentCount} cursor-agent record(s); diagnostic snapshot only`
      );
    }
    if (cursorAgentCount === 0) {
      diagnostics.push('Skipped cursor-agent reap: no cursor-agent attribution record');
      return { killedPids: [], incomplete: false, diagnostics };
    }
    // Neither snapshot owners nor otherAliveTeams authorize or veto runtime cleanup.
    const result = await (
      input.cursorAgentAtomicReap ?? DEFAULT_CURSOR_AGENT_ATOMIC_REAP_PORT
    ).reapUnleasedCursorAgentTrees({
      contractVersion: 1,
      reason: 'team-stop',
      ownedWorkspaceCwds: [workspace],
      startedBeforeMs,
    });
    if (result.killedPids.length > 0) {
      diagnostics.push(`Reaped ${result.killedPids.length} cursor-agent process(es)`);
    }
    diagnostics.push(...result.diagnostics);
    const incomplete = result.status !== 'completed' && result.status !== 'kept';
    if (incomplete && result.diagnostics.length === 0) {
      diagnostics.push(`cursor-agent runtime reap: ${result.status}`);
    }
    return { killedPids: result.killedPids, incomplete, diagnostics };
  } catch (error) {
    diagnostics.push(
      `cursor-agent runtime reap failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return { killedPids: [], incomplete: true, diagnostics };
  }
}
