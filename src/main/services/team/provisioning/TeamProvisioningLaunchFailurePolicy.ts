import { mentionsProcessTableUnavailable } from './TeamProvisioningLaunchDiagnostics';
import { isBootstrapInstructionPrompt } from './TeamProvisioningPromptBuilders';

import type { MemberLaunchState } from '@shared/types';

export function isNeverSpawnedDuringLaunchReason(reason?: string): boolean {
  return reason?.trim() === 'Teammate was never spawned during launch.';
}

export function isLaunchGraceWindowFailureReason(reason?: string): boolean {
  return reason?.trim() === 'Teammate did not join within the launch grace window.';
}

export function isConfigRegistrationFailureReason(reason?: string): boolean {
  return (
    reason?.trim() ===
    'Teammate was not registered in config.json during launch. Persistent spawn failed.'
  );
}

export function isOpenCodeBridgeLaunchFailureReason(reason?: string): boolean {
  return reason?.trim() === 'OpenCode bridge reported member launch failure';
}

export function isRegisteredRuntimeMetadataFailureReason(reason?: string): boolean {
  return reason?.trim() === 'registered runtime metadata without live process';
}

export function isProcessTableUnavailableFailureReason(reason?: string): boolean {
  const text = reason?.trim();
  if (!text || !mentionsProcessTableUnavailable(text)) {
    return false;
  }
  return (
    /^process table (?:is )?unavailable$/i.test(text) ||
    /^runtime pid could not be verified because process table (?:is )?unavailable$/i.test(text)
  );
}

export function stripProcessTableUnavailableDiagnosticSuffix(reason: string): string | null {
  const match = /^(.*?);\s*process table (?:is )?unavailable$/i.exec(reason.trim());
  const baseReason = match?.[1]?.trim();
  return baseReason && baseReason.length > 0 ? baseReason : null;
}

function isBaseAutoClearableLaunchFailureReason(reason?: string): boolean {
  return (
    isNeverSpawnedDuringLaunchReason(reason) ||
    isLaunchGraceWindowFailureReason(reason) ||
    isConfigRegistrationFailureReason(reason) ||
    isRegisteredRuntimeMetadataFailureReason(reason) ||
    isOpenCodeBridgeLaunchFailureReason(reason) ||
    isBootstrapMcpResourceReadFailureReason(reason) ||
    isBootstrapCheckInTimeoutFailureReason(reason) ||
    isBootstrapInstructionPromptFailureReason(reason) ||
    isLaunchCleanupBootstrapIncompleteFailureReason(reason)
  );
}

export function isBootstrapMcpResourceReadFailureReason(reason?: string): boolean {
  const text = reason?.trim().toLowerCase() ?? '';
  return (
    text.includes('resources/read failed') &&
    text.includes('member_briefing') &&
    (text.includes('method not found') || text.includes('mcp error'))
  );
}

export function isBootstrapCheckInTimeoutFailureReason(reason?: string): boolean {
  return reason?.trim() === 'Teammate was registered but did not bootstrap-confirm before timeout.';
}

export function isBootstrapInstructionPromptFailureReason(reason?: string): boolean {
  return typeof reason === 'string' && isBootstrapInstructionPrompt(reason);
}

export function isLaunchCleanupBootstrapIncompleteFailureReason(reason?: string): boolean {
  const text = reason?.trim();
  if (!text) {
    return false;
  }
  if (
    text === 'Launch ended before teammate bootstrap completed.' ||
    text === 'Deterministic bootstrap failed before teammate check-in.'
  ) {
    return true;
  }
  return (
    text.startsWith('Launch ended before teammate bootstrap completed. ') &&
    text.includes('Runtime process was alive after bootstrap failure')
  );
}

export function isAutoClearableLaunchFailureReason(reason?: string): boolean {
  const text = reason?.trim();
  if (!text) {
    return false;
  }
  const baseReason = stripProcessTableUnavailableDiagnosticSuffix(text);
  return (
    isBaseAutoClearableLaunchFailureReason(text) ||
    isProcessTableUnavailableFailureReason(text) ||
    (baseReason != null && isBaseAutoClearableLaunchFailureReason(baseReason))
  );
}

export function deriveMemberLaunchState(entry: {
  agentToolAccepted?: boolean;
  runtimeAlive?: boolean;
  bootstrapConfirmed?: boolean;
  hardFailure?: boolean;
  skippedForLaunch?: boolean;
  pendingPermissionRequestIds?: string[];
}): MemberLaunchState {
  if (entry.skippedForLaunch) {
    return 'skipped_for_launch';
  }
  if (entry.hardFailure) {
    return 'failed_to_start';
  }
  if (entry.bootstrapConfirmed) {
    return 'confirmed_alive';
  }
  if ((entry.pendingPermissionRequestIds?.length ?? 0) > 0) {
    return 'runtime_pending_permission';
  }
  if (entry.runtimeAlive || entry.agentToolAccepted) {
    return 'runtime_pending_bootstrap';
  }
  return 'starting';
}
