import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

const OPENCODE_TEAM_RUNTIME_DIR = '.opencode-runtime';
const OPENCODE_TEAM_RUNTIME_LANES_DIR = 'lanes';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readSessionIdentity(value: unknown): { laneId: string; sessionId: string } | null {
  const entry = asRecord(value);
  if (!entry) {
    return null;
  }
  const sessionId = typeof entry.id === 'string' ? entry.id.trim() : '';
  const laneId = typeof entry.laneId === 'string' ? entry.laneId.trim() : '';
  if (!sessionId || !laneId) {
    return null;
  }
  return { laneId, sessionId };
}

/**
 * Orchestrator Stop events stamp `opencode:${laneId}`. Bind that stamp to the
 * originating event session before comparing with desktop
 * `opencode:${laneId}:${sessionId}` evidence. Never treat a lane-only id as
 * every session on that lane.
 */
export function expandOpenCodeWorkSyncRuntimeInstanceId(
  runtimeInstanceId: string | null | undefined,
  sessionId: string | null | undefined
): string | undefined {
  const runtime = runtimeInstanceId?.trim() ?? '';
  const session = sessionId?.trim() ?? '';
  if (!runtime) {
    return undefined;
  }
  if (!session) {
    return runtime;
  }
  if (runtime.endsWith(`:${session}`)) {
    return runtime;
  }
  const lastSegment = runtime.slice(runtime.lastIndexOf(':') + 1);
  if (/^ses[-_]/i.test(lastSegment)) {
    return runtime;
  }
  if (!runtime.startsWith('opencode:')) {
    return runtime;
  }
  return `${runtime}:${session}`;
}

export function sameOpenCodeWorkSyncRuntimeInstanceId(
  left?: string | null,
  right?: string | null,
  eventSessionId?: string | null
): boolean {
  const first = left?.trim() ?? '';
  const second = right?.trim() ?? '';
  if (!first || !second) {
    return false;
  }
  if (first === second) {
    return true;
  }
  const session = eventSessionId?.trim() ?? '';
  if (!session) {
    return false;
  }
  return (
    expandOpenCodeWorkSyncRuntimeInstanceId(first, session) ===
    expandOpenCodeWorkSyncRuntimeInstanceId(second, session)
  );
}

export async function readOpenCodeWorkSyncCurrentRuntimeInstanceId(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
}): Promise<string | null> {
  const lanesDir = join(
    input.teamsBasePath,
    input.teamName,
    OPENCODE_TEAM_RUNTIME_DIR,
    OPENCODE_TEAM_RUNTIME_LANES_DIR
  );
  let laneDirs: string[] = [];
  try {
    laneDirs = (await readdir(lanesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }

  const wantedMember = input.memberName.trim().toLowerCase();
  let latest: { runtimeInstanceId: string; updatedAtMs: number } | null = null;
  for (const encodedLaneId of laneDirs) {
    const sessionsPath = join(lanesDir, encodedLaneId, 'opencode-sessions.json');
    try {
      const raw = await readFile(sessionsPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const root = asRecord(parsed);
      const payload = asRecord(root?.data) ?? root;
      const sessions = payload?.sessions;
      if (!Array.isArray(sessions)) {
        continue;
      }
      const updatedAtMs = Date.parse(
        typeof payload?.updatedAt === 'string' ? payload.updatedAt : ''
      );
      for (const session of sessions) {
        const entry = asRecord(session);
        const memberName =
          typeof entry?.memberName === 'string' ? entry.memberName.trim().toLowerCase() : '';
        if (memberName !== wantedMember) {
          continue;
        }
        const identity = readSessionIdentity(session);
        if (!identity) {
          continue;
        }
        const candidate = {
          runtimeInstanceId: `opencode:${identity.laneId}:${identity.sessionId}`,
          updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
        };
        if (!latest || candidate.updatedAtMs >= latest.updatedAtMs) {
          latest = candidate;
        }
      }
    } catch {
      // Skip unreadable or malformed lane evidence.
    }
  }
  return latest?.runtimeInstanceId ?? null;
}
