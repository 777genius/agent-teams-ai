import { hostTeamRunId } from '../contracts/teamRunSelection';
import { hostTeamSelectionKey } from '../contracts/teamSelection';

import type { BackendLaunchConfigurationView } from '../contracts/launch';
import type { TeamLaunchDiagnosticItem, TeamProvisioningProgress } from '@shared/types/team';

/** Reuses the existing progress DTO without inventing native PIDs, logs or readiness. */
export function projectHostProvisioningProgress(
  handleId: string,
  view: BackendLaunchConfigurationView
): TeamProvisioningProgress {
  const launch = view.launch;
  const timestamp = (value: unknown): number => {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 8_640_000_000_000_000)
      throw new Error('Host launch timestamps are unavailable');
    return Number(value);
  };
  const startedAt = timestamp(launch.startedAtMs),
    observedAt = timestamp(launch.observedAtMs);
  if (observedAt < startedAt) throw new Error('Host launch clock is inconsistent');
  if (!launch.expected || launch.expected !== launch.members.length)
    throw new Error('Host launch roster is unavailable');
  const members = launch.members;
  const unknown = members.some((member) => member.status === 'unknown');
  const failed = members.filter((member) => member.status === 'failed');
  const stopped =
    failed.length > 0 &&
    members.every(
      (member) =>
        member.status === 'skipped' || (member.status === 'failed' && member.reason === 'stopped')
    );
  const human = members.some((member) => member.status === 'pending-human');
  const pending = members.some((member) =>
    ['not-started', 'pending-bootstrap', 'pending-human'].includes(member.status)
  );
  const partialFailure = failed.length > 0 && pending;
  const allReady =
    members.some((member) => member.usable) &&
    members.every(
      (member) =>
        member.status === 'skipped' ||
        (member.status === 'ready' && member.usable && member.nativeReady)
    );
  const ready = launch.status === 'ready' && allReady;
  if (launch.status === 'ready' && !allReady) throw new Error('Invalid Host aggregate readiness');
  const state: TeamProvisioningProgress['state'] = unknown
    ? 'disconnected'
    : stopped
      ? 'cancelled'
      : failed.length && !pending
        ? 'failed'
        : ready
          ? 'ready'
          : human
            ? 'verifying'
            : 'assembling';
  const message = unknown
    ? 'Some team members have unavailable runtime observations.'
    : stopped
      ? 'Team launch stopped.'
      : partialFailure
        ? 'Some team members failed; other members are still starting.'
        : failed.length
          ? 'Some team members failed to start.'
          : ready
            ? 'Team is ready.'
            : human
              ? 'Waiting for a tool permission or answer.'
              : 'Waiting for native readiness and team context.';
  const observedAtIso = new Date(observedAt).toISOString();
  const diagnostics: TeamLaunchDiagnosticItem[] = [];
  for (const member of members) {
    const name = view.members.find((selected) => selected.memberId === member.memberId)?.label;
    if (!name) throw new Error('Host launch member is unavailable');
    if (member.status === 'not-started' || member.status === 'skipped') continue;
    const code: TeamLaunchDiagnosticItem['code'] =
      member.status === 'ready' && member.usable
        ? 'bootstrap_confirmed'
        : member.status === 'pending-human'
          ? 'permission_pending'
          : member.status === 'unknown'
            ? 'bootstrap_stalled'
            : member.status === 'failed'
              ? 'bootstrap_stalled'
              : 'spawn_accepted';
    diagnostics.push({
      id: `host-launch:${member.memberId}:${member.attemptId}`,
      memberName: name,
      code,
      label: member.reason,
      severity:
        member.status === 'failed' ? 'error' : member.status === 'ready' ? 'info' : 'warning',
      observedAt: observedAtIso,
    });
  }
  return {
    runId: hostTeamRunId(handleId, launch.launchId, launch.rosterRevision),
    teamName: hostTeamSelectionKey(handleId),
    state,
    message,
    startedAt: new Date(startedAt).toISOString(),
    updatedAt: observedAtIso,
    configReady: true,
    launchDiagnostics: diagnostics,
    ...(state === 'failed' ? { error: message, messageSeverity: 'error' as const } : {}),
    ...(unknown || human || partialFailure ? { messageSeverity: 'warning' as const } : {}),
    ...(partialFailure ? { warnings: ['Some team members failed to start.'] } : {}),
  };
}
