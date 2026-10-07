import { createHash } from 'node:crypto';

import type {
  AgentTeamsMcpHttpHealthProbe,
  AgentTeamsMcpHttpIdentity,
} from './AgentTeamsMcpHttpServer';
import type { RuntimeProcessTableRow } from '@features/tmux-installer/main';

export function processDetailsIncludeMarker(details: string, marker: string): boolean {
  return new RegExp(`(^|\\s)${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`).test(
    details
  );
}

export async function hasLiveMcpConsumers(
  rows: readonly RuntimeProcessTableRow[],
  candidatePids: ReadonlySet<number>,
  port: number,
  readDetails: (pid: number) => Promise<string | null>
): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/mcp`;
  const urlHash = createHash('sha256').update(url).digest('hex');
  for (const row of rows) {
    if (candidatePids.has(row.pid)) continue;
    const details = (await readDetails(row.pid)) ?? row.command;
    if (
      processDetailsIncludeMarker(details, `CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL=${url}`) ||
      processDetailsIncludeMarker(details, `CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL_HASH=${urlHash}`)
    )
      return true;
  }
  return false;
}

export async function assertNoLiveMcpConsumers(
  handle: { pid: number | null; port: number } | null,
  listRows: () => Promise<readonly RuntimeProcessTableRow[]>,
  readDetails: (pid: number) => Promise<string | null>
): Promise<void> {
  if (
    handle &&
    (await hasLiveMcpConsumers(
      await listRows(),
      new Set(handle.pid ? [handle.pid] : []),
      handle.port,
      readDetails
    ))
  )
    throw new Error('Stop teams using the MCP connection before changing the app root or context.');
}

/** A prior child is disposable only when its exact original app owner is dead.
 * Unknown old children stay untouched; profile identity never permits adoption.
 * Called again immediately before each destructive phase to reject PID reuse.
 */
export async function canCleanupPriorDesktopMcpChild(input: {
  pid: number;
  startedAtMs: number;
  profile: string | undefined;
  listRows(): Promise<readonly RuntimeProcessTableRow[]>;
  readDetails(pid: number): Promise<string | null>;
  readStartTimeMs(pid: number): Promise<number | null>;
  isProcessAlive(pid: number): boolean;
  probe(): Promise<AgentTeamsMcpHttpHealthProbe>;
  matchesIdentity(identity: AgentTeamsMcpHttpIdentity): boolean;
  hasManagedDetails(details: string): boolean;
}): Promise<boolean> {
  if (!input.profile) return false;
  const row = (await input.listRows()).find((candidate) => candidate.pid === input.pid);
  if (
    !row ||
    (process.platform === 'win32' ? row.ppid > 0 && input.isProcessAlive(row.ppid) : row.ppid !== 1)
  )
    return false;
  if ((await input.readStartTimeMs(input.pid)) !== input.startedAtMs) return false;
  const details = await input.readDetails(input.pid);
  const probe = await input.probe();
  if (
    !details ||
    !input.hasManagedDetails(details) ||
    !probe.healthy ||
    !probe.identity ||
    !input.matchesIdentity(probe.identity)
  )
    return false;
  const ownerPid = Number(
    /(?:^|\s)AGENT_TEAMS_MCP_HTTP_OWNER_PID=(\d+)(?=\s|$)/.exec(details)?.[1]
  );
  return (
    Number.isSafeInteger(ownerPid) &&
    ownerPid > 0 &&
    !input.isProcessAlive(ownerPid) &&
    processDetailsIncludeMarker(details, `CLAUDE_TEAM_APP_PROFILE_SCOPE=${input.profile}`) &&
    processDetailsIncludeMarker(
      details,
      `AGENT_TEAMS_MCP_HTTP_OWNER_INSTANCE_ID=${probe.identity.ownerInstanceId}`
    )
  );
}
