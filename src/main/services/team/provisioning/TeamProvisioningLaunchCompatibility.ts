import { fromProvisioningMembers } from '@features/team-runtime-lanes';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { TeamCreateRequest } from '@shared/types';

export type TeamLaunchCompatibilityLevel = 'ready' | 'repairable' | 'unsafe';
export type TeamLaunchCompatibilityRosterSource = 'members-meta' | 'config' | 'inboxes' | 'missing';
export type TeamLaunchCompatibilityRepairAction = 'materialize-members-meta';

export interface TeamLaunchCompatibilityReport {
  level: TeamLaunchCompatibilityLevel;
  rosterSource: TeamLaunchCompatibilityRosterSource;
  members: TeamCreateRequest['members'];
  warnings: string[];
  blockers: string[];
  repairAction?: TeamLaunchCompatibilityRepairAction;
}

export function isOpenCodeLegacyProvisioningRequest(request: {
  providerId?: unknown;
  members?: readonly { providerId?: unknown; provider?: unknown }[];
}): boolean {
  return (
    normalizeOptionalTeamProviderId(request.providerId) === 'opencode' ||
    (request.members ?? []).some(
      (member) =>
        normalizeOptionalTeamProviderId(member.providerId) === 'opencode' ||
        normalizeOptionalTeamProviderId(member.provider) === 'opencode'
    )
  );
}

export function isPureOpenCodeProvisioningRequest(request: {
  providerId?: unknown;
  members?: readonly { providerId?: unknown; provider?: unknown }[];
}): boolean {
  if (!isOpenCodeLegacyProvisioningRequest(request)) {
    return false;
  }

  const rootProviderId = normalizeOptionalTeamProviderId(request.providerId);
  if (rootProviderId && rootProviderId !== 'opencode') {
    return false;
  }

  return (request.members ?? []).every((member) => {
    const memberProviderId =
      normalizeOptionalTeamProviderId(member.providerId) ??
      normalizeOptionalTeamProviderId(member.provider);
    return !memberProviderId || memberProviderId === 'opencode';
  });
}

export function getOpenCodeMixedProviderProvisioningError(): string {
  return (
    'This OpenCode mixed-team request is outside the current support scope. ' +
    'Supported mixed teams keep the lead on Anthropic or Codex. OpenCode-led mixed teams still remain blocked in this phase.'
  );
}

export function getMixedLaunchFallbackRecoveryError(): string {
  return 'This old mixed team is missing stable member metadata. Open Edit Team and save the roster once before launching.';
}

export function assertOpenCodeNotLaunchedThroughLegacyProvisioning(request: {
  providerId?: unknown;
  members?: readonly { providerId?: unknown; provider?: unknown }[];
}): void {
  if (!isOpenCodeLegacyProvisioningRequest(request)) {
    return;
  }
  const lanePlan = fromProvisioningMembers(
    normalizeOptionalTeamProviderId(request.providerId),
    (request.members ?? []).map((member, index) => ({
      name: `member-${index + 1}`,
      providerId:
        normalizeOptionalTeamProviderId(member.providerId) ??
        normalizeOptionalTeamProviderId(member.provider),
    }))
  );
  if (!lanePlan.ok) {
    throw new Error(lanePlan.message || getOpenCodeMixedProviderProvisioningError());
  }
  if (!isPureOpenCodeProvisioningRequest(request)) {
    return;
  }
  throw new Error(
    'OpenCode team launch is not enabled in the legacy Claude stream-json provisioning path. ' +
      'Use the gated OpenCode runtime adapter once production launch is enabled.'
  );
}

export function mergeProvisioningWarnings(
  existing: string[] | undefined,
  nextWarning: string | null
): string[] | undefined {
  if (!nextWarning) return existing;
  const merged = (existing ?? []).filter((warning) => warning !== nextWarning);
  merged.push(nextWarning);
  return merged.length > 0 ? merged : undefined;
}

const DETERMINISTIC_BOOTSTRAP_LARGE_TEAM_WARNING_THRESHOLD = 8;
const DETERMINISTIC_BOOTSTRAP_MAX_PRIMARY_MEMBERS = 20;

export function buildLargeDeterministicBootstrapWarning(memberCount: number): string | null {
  if (memberCount <= DETERMINISTIC_BOOTSTRAP_LARGE_TEAM_WARNING_THRESHOLD) {
    return null;
  }
  return (
    `Large Codex team launch: ${memberCount} primary teammates will bootstrap in one runtime. ` +
    `Launches above ${DETERMINISTIC_BOOTSTRAP_LARGE_TEAM_WARNING_THRESHOLD} teammates can be slower and more likely to hit provider rate limits or bootstrap timeouts.`
  );
}

export function assertDeterministicBootstrapPrimaryMemberLimit(memberCount: number): void {
  if (memberCount <= DETERMINISTIC_BOOTSTRAP_MAX_PRIMARY_MEMBERS) {
    return;
  }
  throw new Error(
    `Codex deterministic bootstrap currently supports up to ${DETERMINISTIC_BOOTSTRAP_MAX_PRIMARY_MEMBERS} primary teammates; this team has ${memberCount}. Reduce primary teammates or move extra OpenCode members to secondary lanes.`
  );
}
