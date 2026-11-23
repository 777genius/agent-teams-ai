import type { TeamLaunchDiagnosticItem, TeamProvisioningProgress } from '@shared/types';

function stringArraysEqual(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function launchDiagnosticsEqual(
  a: readonly TeamLaunchDiagnosticItem[] | undefined,
  b: readonly TeamLaunchDiagnosticItem[] | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      !left ||
      !right ||
      left.id !== right.id ||
      left.memberName !== right.memberName ||
      left.severity !== right.severity ||
      left.code !== right.code ||
      left.label !== right.label ||
      left.detail !== right.detail ||
      left.observedAt !== right.observedAt
    ) {
      return false;
    }
  }
  return true;
}

export function provisioningProgressPayloadEqual(
  a: TeamProvisioningProgress,
  b: TeamProvisioningProgress
): boolean {
  return (
    a.runId === b.runId &&
    a.teamName === b.teamName &&
    a.state === b.state &&
    a.message === b.message &&
    a.messageSeverity === b.messageSeverity &&
    a.startedAt === b.startedAt &&
    a.pid === b.pid &&
    a.error === b.error &&
    a.cliLogsTail === b.cliLogsTail &&
    a.assistantOutput === b.assistantOutput &&
    a.configReady === b.configReady &&
    a.retainedSecondaryRuntime === b.retainedSecondaryRuntime &&
    stringArraysEqual(a.warnings, b.warnings) &&
    launchDiagnosticsEqual(a.launchDiagnostics, b.launchDiagnostics)
  );
}
