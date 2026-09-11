import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { stableHash } from '../bridge/OpenCodeBridgeCommandContract';

/** App-owned session identity only; mutable readiness/heartbeat fields are excluded. */
export async function readOpenCodeStopSessions(
  manifestPath: string,
  scope?: { teamName: string; laneId: string; runId: string | null }
) {
  let raw: string;
  try {
    raw = await readFile(path.join(path.dirname(manifestPath), 'opencode-sessions.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed = JSON.parse(raw);
  const sessions: unknown = (parsed.data ?? parsed).sessions;
  if (!Array.isArray(sessions)) throw new Error('Cannot establish OpenCode Stop session identity');
  const identities = sessions.map((session: unknown) => {
    if (!session || typeof session !== 'object') throw new Error('Invalid Stop session identity');
    const entry = session as Record<string, unknown>;
    if (['id', 'teamName', 'memberName', 'laneId'].some((key) => typeof entry[key] !== 'string')) {
      throw new Error('Invalid Stop session identity');
    }
    if (entry.runId !== undefined && entry.runId !== null && typeof entry.runId !== 'string')
      throw new Error('Invalid Stop run identity');
    return {
      teamName: entry.teamName as string,
      laneId: entry.laneId as string,
      runId: entry.runId ?? null,
      memberName: entry.memberName as string,
      sessionId: entry.id as string,
    };
  });
  if (!scope) return identities;
  if (
    (identities.length > 0 && !scope.runId) ||
    identities.some(
      (session) =>
        session.teamName !== scope.teamName ||
        session.laneId !== scope.laneId ||
        typeof session.runId !== 'string' ||
        !session.runId.trim()
    )
  )
    throw new Error('Cannot establish exact OpenCode Stop session scope');
  // The store retains prior incarnations. They are evidence, not targets of
  // the active run's Stop. Keep the unscoped reader for full-store cleanup CAS.
  return identities.filter((session) => session.runId === scope.runId);
}

export async function readOpenCodeStopSessionIdentity(manifestPath: string): Promise<string> {
  return hashOpenCodeStopSessions(await readOpenCodeStopSessions(manifestPath));
}
export function hashOpenCodeStopSessions(
  sessions: Awaited<ReturnType<typeof readOpenCodeStopSessions>>
): string {
  return stableHash(
    sessions
      .map((s) => [s.teamName, s.laneId, s.runId, s.memberName, s.sessionId])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  );
}
