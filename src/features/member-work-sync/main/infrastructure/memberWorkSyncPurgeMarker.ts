import type { DurablePathIdentity } from '@main/utils/atomicWrite';

/** Durable record that a team's primary work-sync state is being purged. */
export interface PendingPrimaryPurgeMarker {
  schemaVersion: 2;
  teamName: string;
  deletionIdentityId: string | null;
  teamRootIdentity: DurablePathIdentity | null;
  activeJsonStateCleared: boolean;
  recoverySafe: boolean;
}

export function parseDurablePathIdentity(value: unknown): DurablePathIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const identity = value as Partial<DurablePathIdentity>;
  return typeof identity.dev === 'number' &&
    Number.isFinite(identity.dev) &&
    typeof identity.ino === 'number' &&
    Number.isFinite(identity.ino) &&
    typeof identity.birthtimeMs === 'number' &&
    Number.isFinite(identity.birthtimeMs)
    ? {
        dev: identity.dev,
        ino: identity.ino,
        birthtimeMs: identity.birthtimeMs,
      }
    : null;
}

/** Fail-closed parse of the marker file: a malformed marker is never `recoverySafe`. */
export function parsePendingPrimaryPurgeMarker(
  raw: string,
  teamName: string
): PendingPrimaryPurgeMarker {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const deletionIdentityId =
      typeof parsed.deletionIdentityId === 'string' && parsed.deletionIdentityId.trim()
        ? parsed.deletionIdentityId.trim()
        : null;
    const teamRootIdentity = parseDurablePathIdentity(parsed.teamRootIdentity);
    const recoverySafe =
      parsed.schemaVersion === 2 &&
      typeof parsed.teamName === 'string' &&
      parsed.teamName.trim().toLowerCase() === teamName.trim().toLowerCase() &&
      (deletionIdentityId !== null || teamRootIdentity !== null);
    return {
      schemaVersion: 2,
      teamName: teamName.trim(),
      deletionIdentityId,
      teamRootIdentity,
      activeJsonStateCleared: parsed.activeJsonStateCleared === true,
      recoverySafe,
    };
  } catch {
    return {
      schemaVersion: 2,
      teamName: teamName.trim(),
      deletionIdentityId: null,
      teamRootIdentity: null,
      activeJsonStateCleared: false,
      recoverySafe: false,
    };
  }
}
