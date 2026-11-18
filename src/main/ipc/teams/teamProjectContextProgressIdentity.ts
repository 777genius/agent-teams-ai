import type { TeamProvisioningProgress } from '@shared/types';

/**
 * Runtime status remains physical internally. UI polling and pushed events
 * must both identify the same logical team for a project-scoped launch.
 */
interface RunIdentity {
  logicalTeam: string;
  physicalTeam: string;
  registeredAt: number;
}

const RUN_LIMIT = 128;
const RETENTION_MS = 4 * 60 * 60 * 1000;
const identities = new Map<string, RunIdentity>();

export function rememberProjectRunIdentity(
  runId: string,
  logicalTeam: string,
  physicalTeam: string
): void {
  if (!runId || !logicalTeam || !physicalTeam || logicalTeam === physicalTeam) return;
  const now = Date.now();
  for (const [key, row] of identities) {
    if (now - row.registeredAt > RETENTION_MS) identities.delete(key);
  }
  if (identities.size >= RUN_LIMIT) {
    const oldest = identities.keys().next().value;
    if (oldest) identities.delete(oldest);
  }
  identities.set(runId, { logicalTeam, physicalTeam, registeredAt: now });
}

/**
 * Diagnostic artifacts use the native team directory, while the UI receives
 * the logical identity. Only route a known exact run belonging to this logical
 * team; never guess an alias from a prefix or unrelated run ID.
 */
export function resolveProjectRunDiagnosticsTeam(
  logicalTeam: string,
  runId: string | undefined
): string {
  if (!runId) return logicalTeam;
  const row = identities.get(runId);
  if (!row || row.logicalTeam !== logicalTeam) return logicalTeam;
  if (Date.now() - row.registeredAt > RETENTION_MS) {
    identities.delete(runId);
    return logicalTeam;
  }
  return row.physicalTeam;
}

export function projectPublicProvisioningProgress(
  progress: TeamProvisioningProgress
): TeamProvisioningProgress {
  const row = identities.get(progress.runId);
  if (!row || row.physicalTeam !== progress.teamName) return progress;
  if (Date.now() - row.registeredAt > RETENTION_MS) {
    identities.delete(progress.runId);
    return progress;
  }
  return { ...progress, teamName: row.logicalTeam };
}
