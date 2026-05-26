import {
  hasUnsafeProvisionedButNotAliveRuntimeEvidence,
  isBootstrapConfirmedProvisionedButNotAliveFailure,
  mentionsProcessTableUnavailable,
} from '@shared/utils/teamLaunchFailureReason';

import type { WorkspaceTrustExecutionResult } from '@features/workspace-trust/main';
import type { MemberSpawnStatusEntry, TeamLaunchDiagnosticItem } from '@shared/types';

export { mentionsProcessTableUnavailable };

export interface TeamProvisioningLaunchDiagnosticsRun {
  isLaunch: boolean;
  memberSpawnStatuses?: ReadonlyMap<string, MemberSpawnStatusEntry> | null;
}

interface LaunchDiagnosticsClockOptions {
  nowIso?: () => string;
}

const defaultNowIso = (): string => new Date().toISOString();

export function buildLaunchDiagnosticsFromRun(
  run: TeamProvisioningLaunchDiagnosticsRun,
  options: LaunchDiagnosticsClockOptions = {}
): TeamLaunchDiagnosticItem[] | undefined {
  const memberSpawnStatuses = run.memberSpawnStatuses;
  if (!run.isLaunch || !memberSpawnStatuses || memberSpawnStatuses.size === 0) {
    return undefined;
  }

  const observedAt = (options.nowIso ?? defaultNowIso)();
  const items: TeamLaunchDiagnosticItem[] = [];
  for (const [memberName, entry] of memberSpawnStatuses.entries()) {
    const bootstrapConfirmedProvisionedButNotAlive =
      isBootstrapConfirmedProvisionedButNotAliveFailure(entry);
    if (
      bootstrapConfirmedProvisionedButNotAlive &&
      hasUnsafeProvisionedButNotAliveRuntimeEvidence(entry)
    ) {
      items.push({
        id: `${memberName}:bootstrap_stalled`,
        memberName,
        severity: 'error',
        code: 'bootstrap_stalled',
        label: `${memberName} - launch diagnostic error`,
        detail: entry.runtimeDiagnostic ?? entry.hardFailureReason ?? entry.error,
        observedAt,
      });
      continue;
    }
    if (entry.launchState === 'confirmed_alive' || bootstrapConfirmedProvisionedButNotAlive) {
      items.push({
        id: `${memberName}:bootstrap_confirmed`,
        memberName,
        severity: 'info',
        code: 'bootstrap_confirmed',
        label: `${memberName} - bootstrap confirmed`,
        observedAt,
      });
      continue;
    }
    if (entry.launchState === 'failed_to_start') {
      items.push({
        id: `${memberName}:bootstrap_stalled`,
        memberName,
        severity: 'error',
        code: 'bootstrap_stalled',
        label: `${memberName} - failed to start`,
        detail: entry.hardFailureReason ?? entry.error,
        observedAt,
      });
      continue;
    }
    if (entry.launchState === 'runtime_pending_permission') {
      items.push({
        id: `${memberName}:permission_pending`,
        memberName,
        severity: 'warning',
        code: 'permission_pending',
        label: `${memberName} - awaiting permission`,
        detail: entry.runtimeDiagnostic,
        observedAt,
      });
      continue;
    }
    if (entry.bootstrapStalled === true) {
      items.push({
        id: `${memberName}:bootstrap_stalled`,
        memberName,
        severity: 'warning',
        code: 'bootstrap_stalled',
        label: `${memberName} - bootstrap stalled`,
        detail: entry.runtimeDiagnostic,
        observedAt,
      });
      continue;
    }
    if (mentionsProcessTableUnavailable(entry.runtimeDiagnostic)) {
      items.push({
        id: `${memberName}:process_table_unavailable`,
        memberName,
        severity: 'warning',
        code: 'process_table_unavailable',
        label: `${memberName} - process table unavailable`,
        detail: entry.runtimeDiagnostic,
        observedAt,
      });
      continue;
    }
    if (entry.livenessKind === 'shell_only') {
      items.push({
        id: `${memberName}:tmux_shell_only`,
        memberName,
        severity: 'warning',
        code: 'tmux_shell_only',
        label: `${memberName} - shell only`,
        detail: entry.runtimeDiagnostic,
        observedAt,
      });
      continue;
    }
    if (entry.livenessKind === 'runtime_process_candidate') {
      items.push({
        id: `${memberName}:runtime_process_candidate`,
        memberName,
        severity: 'warning',
        code: 'runtime_process_candidate',
        label: `${memberName} - bootstrap unconfirmed`,
        detail: entry.runtimeDiagnostic,
        observedAt,
      });
      continue;
    }
    if (entry.livenessKind === 'runtime_process') {
      items.push({
        id: `${memberName}:runtime_process_detected`,
        memberName,
        severity: 'info',
        code: 'runtime_process_detected',
        label: `${memberName} - waiting for bootstrap`,
        detail: entry.runtimeDiagnostic,
        observedAt,
      });
      continue;
    }
    if (
      entry.livenessKind === 'registered_only' ||
      entry.livenessKind === 'stale_metadata' ||
      entry.livenessKind === 'not_found'
    ) {
      items.push({
        id: `${memberName}:runtime_not_found`,
        memberName,
        severity: 'warning',
        code: 'runtime_not_found',
        label: `${memberName} - waiting for runtime`,
        detail: entry.runtimeDiagnostic,
        observedAt,
      });
      continue;
    }
    if (entry.agentToolAccepted) {
      items.push({
        id: `${memberName}:spawn_accepted`,
        memberName,
        severity: 'info',
        code: 'spawn_accepted',
        label: `${memberName} - spawn accepted`,
        detail: entry.runtimeDiagnostic,
        observedAt,
      });
    }
  }
  return items.length > 0 ? items : undefined;
}

export function buildWorkspaceTrustPreflightLaunchDiagnostic(
  execution: WorkspaceTrustExecutionResult,
  options: LaunchDiagnosticsClockOptions = {}
): TeamLaunchDiagnosticItem | null {
  if (execution.status === 'cancelled') {
    return null;
  }

  const severity =
    execution.status === 'blocked'
      ? 'error'
      : execution.status === 'soft_failed'
        ? 'warning'
        : 'info';
  const label =
    execution.status === 'blocked'
      ? 'Workspace trust preflight blocked launch'
      : execution.status === 'soft_failed'
        ? 'Workspace trust preflight could not verify trust'
        : 'Workspace trust preflight completed';
  const detail =
    execution.errorMessage?.trim() ||
    execution.errorCode?.trim() ||
    execution.evidence?.find((item) => item.trim().length > 0)?.trim();

  return {
    id: 'workspace-trust:preflight',
    severity,
    code: 'workspace_trust_preflight',
    label,
    ...(detail ? { detail } : {}),
    observedAt: (options.nowIso ?? defaultNowIso)(),
  };
}

export function mergeLaunchDiagnosticItem(
  items: readonly TeamLaunchDiagnosticItem[] | undefined,
  item: TeamLaunchDiagnosticItem
): TeamLaunchDiagnosticItem[] {
  return [...(items ?? []).filter((candidate) => candidate.id !== item.id), item];
}
