import { parseNumericSuffixName } from '@shared/utils/teamMemberName';

import {
  createInitialMemberSpawnStatusEntry,
  MEMBER_LAUNCH_GRACE_MS,
  shouldWarnOnMissingRegisteredMember,
  shouldWarnOnUnreadableMemberAuditConfig,
} from './TeamProvisioningMemberSpawnStatusPolicy';
import {
  markOpenCodeSecondaryBootstrapStalled,
  type MarkOpenCodeSecondaryBootstrapStalledPorts,
  type OpenCodeBootstrapStallRunLike,
  type ReconcileOpenCodeRuntimeProcessBootstrapPorts,
  reconcileOpenCodeRuntimeProcessBootstrapStatus,
} from './TeamProvisioningOpenCodeBootstrapStall';

import type {
  MemberSpawnLivenessSource,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
} from '@shared/types';

export interface RegisteredMemberAuditRun extends OpenCodeBootstrapStallRunLike {
  expectedMembers: string[];
  pendingMemberRestarts?: ReadonlyMap<string, unknown>;
  lastMemberSpawnAuditConfigReadWarningAt: number;
  lastMemberSpawnAuditMissingWarningAt: Map<string, number>;
}

export interface ReadRegisteredTeamMemberNamesPorts {
  readRegularFileUtf8(
    filePath: string,
    opts: { timeoutMs: number; maxBytes: number }
  ): Promise<string | null>;
}

export interface AuditRegisteredMemberSpawnStatusPorts<TRun extends RegisteredMemberAuditRun> {
  nowMs(): number;
  getRegisteredTeamMemberNames(teamName: string): Promise<ReadonlySet<string> | null>;
  hasTeamDirectory(teamName: string): Promise<boolean>;
  getLiveTeamAgentNames(teamName: string): Promise<ReadonlySet<string>>;
  isOpenCodeSecondaryLaneMemberInRun(run: TRun, memberName: string): boolean;
  isOpenCodeBootstrapStallWindowElapsed(firstSpawnAcceptedAt: string | undefined): boolean;
  getOpenCodeBootstrapStallReconciliationPorts(): ReconcileOpenCodeRuntimeProcessBootstrapPorts &
    MarkOpenCodeSecondaryBootstrapStalledPorts;
  setMemberSpawnStatus(
    run: TRun,
    memberName: string,
    status: MemberSpawnStatus,
    error?: string,
    livenessSource?: MemberSpawnLivenessSource
  ): void;
  debug(message: string): void;
  warn(message: string): void;
}

export function parseRegisteredTeamMemberNamesFromConfigJson(raw: string): Set<string> {
  const config = JSON.parse(raw) as {
    members?: { name?: string; agentType?: string }[];
  };
  return new Set(
    (config.members ?? [])
      .map((member) => (typeof member.name === 'string' ? member.name.trim() : ''))
      .filter(Boolean)
  );
}

export async function readRegisteredTeamMemberNamesFromConfig(input: {
  configPath: string;
  timeoutMs: number;
  maxBytes: number;
  ports: ReadRegisteredTeamMemberNamesPorts;
}): Promise<Set<string> | null> {
  try {
    const raw = await input.ports.readRegularFileUtf8(input.configPath, {
      timeoutMs: input.timeoutMs,
      maxBytes: input.maxBytes,
    });
    if (!raw) {
      return null;
    }
    return parseRegisteredTeamMemberNamesFromConfigJson(raw);
  } catch {
    return null;
  }
}

export async function auditRegisteredMemberSpawnStatuses<
  TRun extends RegisteredMemberAuditRun,
>(run: TRun, ports: AuditRegisteredMemberSpawnStatusPorts<TRun>): Promise<void> {
  if (!run.expectedMembers || run.expectedMembers.length === 0) return;

  const registeredNames = await ports.getRegisteredTeamMemberNames(run.teamName);
  if (!registeredNames) {
    if (!(await ports.hasTeamDirectory(run.teamName))) {
      return;
    }
    const now = ports.nowMs();
    if (
      shouldWarnOnUnreadableMemberAuditConfig({
        nowMs: now,
        lastWarnAt: run.lastMemberSpawnAuditConfigReadWarningAt,
        expectedMembers: run.expectedMembers,
        memberSpawnStatuses: run.memberSpawnStatuses,
      })
    ) {
      run.lastMemberSpawnAuditConfigReadWarningAt = now;
      ports.debug(`[${run.teamName}] auditMemberSpawnStatuses: config.json not readable`);
    }
    return;
  }

  const liveAgentNames = await ports.getLiveTeamAgentNames(run.teamName);

  for (const expected of run.expectedMembers) {
    const current = run.memberSpawnStatuses.get(expected);
    if (shouldSkipRegisteredMemberAuditEntry(current)) {
      continue;
    }

    const matchedRuntimeNames = getMatchingRegisteredRuntimeNames(registeredNames, expected);
    const runtimeAlive =
      liveAgentNames.has(expected) ||
      matchedRuntimeNames.some((runtimeName) => liveAgentNames.has(runtimeName));

    if (runtimeAlive) {
      if (ports.isOpenCodeSecondaryLaneMemberInRun(run, expected)) {
        const base = current ?? createInitialMemberSpawnStatusEntry();
        const bootstrapStalled =
          base.bootstrapStalled === true ||
          ports.isOpenCodeBootstrapStallWindowElapsed(base.firstSpawnAcceptedAt);
        await reconcileOpenCodeRuntimeProcessBootstrapStatus(
          {
            run,
            memberName: expected,
            current: base,
            bootstrapStalled,
            runtimeDiagnostic: base.runtimeDiagnostic,
            runtimeDiagnosticSeverity: base.runtimeDiagnosticSeverity,
            scheduleReevaluation: false,
          },
          ports.getOpenCodeBootstrapStallReconciliationPorts()
        );
        continue;
      }
      ports.setMemberSpawnStatus(run, expected, 'online', undefined, 'process');
      continue;
    }

    if (matchedRuntimeNames.length > 0) {
      if (current?.agentToolAccepted) {
        if (
          await markOpenCodeSecondaryBootstrapStalled(
            {
              run,
              memberName: expected,
              current,
              isOpenCodeSecondaryLaneMember: ports.isOpenCodeSecondaryLaneMemberInRun(
                run,
                expected
              ),
              bootstrapStallWindowElapsed: ports.isOpenCodeBootstrapStallWindowElapsed(
                current.firstSpawnAcceptedAt
              ),
            },
            ports.getOpenCodeBootstrapStallReconciliationPorts()
          )
        ) {
          continue;
        }
        ports.setMemberSpawnStatus(run, expected, 'waiting');
      }
      continue;
    }

    if (run.pendingMemberRestarts?.has(expected) === true) {
      continue;
    }

    const acceptedAtMs =
      current?.firstSpawnAcceptedAt != null ? Date.parse(current.firstSpawnAcceptedAt) : NaN;
    const graceExpired =
      current?.agentToolAccepted === true &&
      Number.isFinite(acceptedAtMs) &&
      ports.nowMs() - acceptedAtMs >= MEMBER_LAUNCH_GRACE_MS;

    if (current?.agentToolAccepted && !graceExpired) {
      ports.setMemberSpawnStatus(run, expected, 'waiting');
      continue;
    }

    const now = ports.nowMs();
    const lastWarnAt = run.lastMemberSpawnAuditMissingWarningAt.get(expected) ?? 0;
    if (
      shouldWarnOnMissingRegisteredMember({
        nowMs: now,
        lastWarnAt,
        graceExpired,
      })
    ) {
      run.lastMemberSpawnAuditMissingWarningAt.set(expected, now);
      ports.warn(
        `[${run.teamName}] Member "${expected}" not found in config.json members after provisioning`
      );
    }
    if (graceExpired) {
      ports.setMemberSpawnStatus(
        run,
        expected,
        'error',
        'Teammate not registered after provisioning within the launch grace window.'
      );
    }
  }
}

function shouldSkipRegisteredMemberAuditEntry(
  current: MemberSpawnStatusEntry | undefined
): boolean {
  return (
    current?.launchState === 'failed_to_start' ||
    current?.launchState === 'confirmed_alive' ||
    current?.launchState === 'skipped_for_launch' ||
    current?.skippedForLaunch === true
  );
}

function getMatchingRegisteredRuntimeNames(
  registeredNames: ReadonlySet<string>,
  expected: string
): string[] {
  return [...registeredNames].filter((name) => {
    if (name === expected) return true;
    const parsed = parseNumericSuffixName(name);
    return parsed !== null && parsed.suffix >= 2 && parsed.base === expected;
  });
}
