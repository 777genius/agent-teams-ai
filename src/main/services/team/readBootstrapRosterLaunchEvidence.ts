import * as fs from 'fs';

import { getTeamBootstrapStatePath } from './TeamBootstrapStateReader';

export type BootstrapRosterLaunchEvidence =
  | { state: 'unknown' }
  | { state: 'started' }
  | { state: 'not-started'; message: string };

/** Read-only command/run evidence used by roster outcome crash recovery. */
export async function readBootstrapRosterLaunchEvidence(
  teamName: string,
  expectedRunId: string,
  expectedMemberNames: readonly string[] = []
): Promise<BootstrapRosterLaunchEvidence> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(
      await fs.promises.readFile(getTeamBootstrapStatePath(teamName), 'utf8')
    ) as Record<string, unknown>;
  } catch {
    return { state: 'unknown' };
  }
  if (typeof raw.runId !== 'string' || raw.runId.trim() !== expectedRunId) {
    return { state: 'unknown' };
  }
  const terminal =
    raw.terminal && typeof raw.terminal === 'object'
      ? (raw.terminal as Record<string, unknown>)
      : null;
  const terminalStatus = typeof terminal?.status === 'string' ? terminal.status : null;
  if (terminalStatus === 'completed' || terminalStatus === 'partial_success') {
    return { state: 'started' };
  }
  const members = (Array.isArray(raw.members) ? raw.members : []).flatMap((member) => {
    if (!member || typeof member !== 'object') return [];
    const record = member as Record<string, unknown>;
    const status = record.status;
    const name = record.name;
    return typeof status === 'string' && typeof name === 'string'
      ? [{ name: name.trim().toLowerCase(), status }]
      : [];
  });
  const statuses = members.map(({ status }) => status);
  const expected = [
    ...new Set(expectedMemberNames.map((name) => name.trim().toLowerCase())),
  ].sort();
  const observed = [...new Set(members.map(({ name }) => name))].sort();
  const exactRoster =
    expected.length > 0 &&
    expected.length === members.length &&
    expected.length === observed.length &&
    expected.every((name, index) => name === observed[index]);
  const cleanupConfirmed =
    terminal?.cleanupConfirmed === true && terminal?.processResourcesRetained === false;
  if (
    (terminalStatus === 'failed' || terminalStatus === 'canceled') &&
    exactRoster &&
    cleanupConfirmed &&
    statuses.every((status) => status === 'failed')
  ) {
    return {
      state: 'not-started',
      message: `Durable bootstrap ${terminalStatus} before any retained member spawn`,
    };
  }
  return statuses.includes('bootstrap_confirmed') ? { state: 'started' } : { state: 'unknown' };
}
