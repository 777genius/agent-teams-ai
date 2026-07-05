import {
  type LaunchExpectedMembersResolution,
  resolveLaunchExpectedMembersFromCompatibilityReport,
} from './TeamProvisioningConfigLaunchNormalization';
import {
  buildConfigLaunchCompatibilityReport,
  buildInboxLaunchCompatibilityReport,
  buildLaunchMembersFromMeta,
  extractTeammateSpecsFromConfig,
  selectLaunchCompatibilityInboxNames,
} from './TeamProvisioningConfigMaterialization';

import type { TeamLaunchCompatibilityReport } from './TeamProvisioningLaunchCompatibility';
import type { TeamMember, TeamProviderId } from '@shared/types';

export interface ResolveLaunchExpectedMembersInput {
  teamName: string;
  configRaw: string;
  leadProviderId?: TeamProviderId;
}

export interface TeamProvisioningLaunchExpectedMembersPorts {
  readLaunchState(teamName: string): Promise<unknown>;
  readBootstrapLaunchSnapshot(teamName: string): Promise<unknown>;
  getMembers(teamName: string): Promise<TeamMember[]>;
  listInboxNames(teamName: string): Promise<string[]>;
  warn(message: string): void;
}

export async function resolveLaunchExpectedMembers(
  input: ResolveLaunchExpectedMembersInput,
  ports: TeamProvisioningLaunchExpectedMembersPorts
): Promise<LaunchExpectedMembersResolution> {
  return resolveLaunchExpectedMembersFromCompatibility(await probeLaunchCompatibility(input, ports));
}

export function resolveLaunchExpectedMembersFromCompatibility(
  report: TeamLaunchCompatibilityReport
): LaunchExpectedMembersResolution {
  return resolveLaunchExpectedMembersFromCompatibilityReport(report);
}

export async function probeLaunchCompatibility(
  input: ResolveLaunchExpectedMembersInput,
  ports: TeamProvisioningLaunchExpectedMembersPorts
): Promise<TeamLaunchCompatibilityReport> {
  const { teamName, configRaw, leadProviderId } = input;

  // Keep this probe read-only: launch-state/bootstrap-state may inform existing resume guards,
  // but compatibility repair must not mutate or trust stale runtime projections.
  await Promise.allSettled([
    ports.readLaunchState(teamName),
    ports.readBootstrapLaunchSnapshot(teamName),
  ]);

  try {
    const metaMembers = await ports.getMembers(teamName);
    const members = buildLaunchMembersFromMeta(metaMembers);
    if (members.length > 0) {
      return {
        level: 'ready',
        rosterSource: 'members-meta',
        members,
        warnings: [],
        blockers: [],
      };
    }
  } catch (error) {
    ports.warn(
      `[${teamName}] Failed to read members.meta.json: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const configMembers = extractTeammateSpecsFromConfig(configRaw);
  if (configMembers.length === 0) {
    try {
      JSON.parse(configRaw);
    } catch {
      ports.warn(`[${teamName}] Failed to parse config.json for launch fallback members`);
    }
  }

  try {
    const inboxNames = selectLaunchCompatibilityInboxNames(await ports.listInboxNames(teamName));
    if (inboxNames.length > 0) {
      return buildInboxLaunchCompatibilityReport({
        teamName,
        inboxNames,
        configMembers,
        leadProviderId,
      });
    }
  } catch (error) {
    ports.warn(
      `[${teamName}] Failed to read inbox member names: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (configMembers.length > 0) {
    return buildConfigLaunchCompatibilityReport(teamName, configMembers, leadProviderId);
  }

  let configParseFailed = false;
  try {
    JSON.parse(configRaw);
  } catch {
    configParseFailed = true;
  }

  return {
    level: 'ready',
    rosterSource: 'missing',
    members: [],
    warnings: configParseFailed
      ? [
          'Config could not be parsed during launch roster discovery. ' +
            'Launch will continue without explicit teammate names.',
        ]
      : [],
    blockers: [],
  };
}
