import { isLeadMember } from '@shared/utils/leadDetection';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';

import {
  HARNESS_DEFAULT_NOW_ISO,
  HARNESS_DEFAULT_TEAM_NAME,
  HARNESS_INERT_MODEL,
  HARNESS_INERT_PROJECT_PATH,
  HARNESS_INERT_PROVIDER_BACKEND_ID,
  HARNESS_LEAD_AGENT_TYPE,
  HARNESS_TEAMMATE_AGENT_TYPE,
} from './fixtureConstants';
import { assertNoSecretLikeFixtureValues } from './fixtureSecrets';
import { cloneFixture } from './harnessData';

import type { TeamMetaFile } from '@main/services/team/TeamMetaStore';
import type { TeamConfig, TeamCreateRequest, TeamMember, TeamProviderId } from '@shared/types';

export type MemberFixtureOptions = Partial<TeamMember>;

function member(
  name: string,
  providerId: TeamProviderId,
  role: string,
  agentType: typeof HARNESS_LEAD_AGENT_TYPE | typeof HARNESS_TEAMMATE_AGENT_TYPE,
  overrides: MemberFixtureOptions = {}
): TeamMember {
  const overridden: TeamMember = {
    role,
    providerId,
    providerBackendId: HARNESS_INERT_PROVIDER_BACKEND_ID,
    model: HARNESS_INERT_MODEL,
    ...overrides,
    name,
    agentType,
  };
  const fixture: TeamMember = {
    ...overridden,
    providerBackendId: migrateProviderBackendId(
      overridden.providerId,
      overridden.providerBackendId
    ),
  };
  assertNoSecretLikeFixtureValues(fixture);
  return cloneFixture(fixture);
}

export const memberFixture = {
  lead(overrides: MemberFixtureOptions = {}): TeamMember {
    return member('Lead', 'codex', 'Team Lead', HARNESS_LEAD_AGENT_TYPE, overrides);
  },

  codex(name: string, overrides: MemberFixtureOptions = {}): TeamMember {
    return member(name, 'codex', 'Engineer', HARNESS_TEAMMATE_AGENT_TYPE, overrides);
  },

  anthropic(name: string, overrides: MemberFixtureOptions = {}): TeamMember {
    return member(name, 'anthropic', 'Engineer', HARNESS_TEAMMATE_AGENT_TYPE, overrides);
  },

  opencode(name: string, overrides: MemberFixtureOptions = {}): TeamMember {
    return member(name, 'opencode', 'Engineer', HARNESS_TEAMMATE_AGENT_TYPE, overrides);
  },
};

function normalizeMemberForConfig(memberValue: TeamMember, isLead: boolean): TeamMember {
  return {
    ...cloneFixture(memberValue),
    providerBackendId: migrateProviderBackendId(
      memberValue.providerId,
      memberValue.providerBackendId
    ),
    agentType: isLead ? HARNESS_LEAD_AGENT_TYPE : HARNESS_TEAMMATE_AGENT_TYPE,
  };
}

function normalizeConfigMembers(members: readonly TeamMember[]): TeamMember[] {
  let leadSeen = false;
  const normalized: TeamMember[] = [];
  for (const memberValue of members) {
    const isLead = isLeadMember(memberValue);
    if (isLead && leadSeen) {
      continue;
    }
    leadSeen ||= isLead;
    normalized.push(normalizeMemberForConfig(memberValue, isLead));
  }
  return normalized;
}

export function normalizeTeamConfigFixture(config: TeamConfig): TeamConfig {
  const fixture: TeamConfig = {
    ...cloneFixture(config),
    members: config.members ? normalizeConfigMembers(config.members) : config.members,
  };
  assertNoSecretLikeFixtureValues(fixture);
  return fixture;
}

export type TeamConfigFixtureOptions = Partial<TeamConfig> & {
  teamName?: string;
};

export const teamConfigFixture = {
  basic(options: TeamConfigFixtureOptions = {}): TeamConfig {
    const {
      teamName = HARNESS_DEFAULT_TEAM_NAME,
      members = [memberFixture.lead(), memberFixture.codex('Builder')],
      projectPath = HARNESS_INERT_PROJECT_PATH,
      ...overrides
    } = options;

    return normalizeTeamConfigFixture({
      name: overrides.name ?? teamName,
      description: 'Harness fixture team',
      color: 'blue',
      projectPath,
      leadSessionId: 'harness-lead-session',
      members,
      ...overrides,
    });
  },
};

export type TeamMetaFixtureOptions = Partial<Omit<TeamMetaFile, 'version'>>;

export const teamMetaFixture = {
  basic(options: TeamMetaFixtureOptions = {}): TeamMetaFile {
    const overridden: TeamMetaFile = {
      version: 1,
      displayName: HARNESS_DEFAULT_TEAM_NAME,
      description: 'Harness fixture team',
      color: 'blue',
      cwd: HARNESS_INERT_PROJECT_PATH,
      providerId: 'codex',
      providerBackendId: HARNESS_INERT_PROVIDER_BACKEND_ID,
      model: HARNESS_INERT_MODEL,
      createdAt: Date.parse(HARNESS_DEFAULT_NOW_ISO),
      ...options,
    };
    const fixture: TeamMetaFile = {
      ...overridden,
      providerBackendId: migrateProviderBackendId(
        overridden.providerId,
        overridden.providerBackendId
      ),
    };
    assertNoSecretLikeFixtureValues(fixture);
    return cloneFixture(fixture);
  },
};

export function toMetaMembers(members: TeamCreateRequest['members']): TeamMember[] {
  return cloneFixture(
    members
      .filter((memberValue) => !isLeadMember(memberValue))
      .map(
        (memberValue) =>
          ({
            name: memberValue.name,
            role: memberValue.role,
            workflow: memberValue.workflow,
            isolation: memberValue.isolation,
            cwd: memberValue.cwd,
            providerId: memberValue.providerId,
            providerBackendId: migrateProviderBackendId(
              memberValue.providerId,
              memberValue.providerBackendId
            ),
            model: memberValue.model,
            effort: memberValue.effort,
            mcpPolicy: memberValue.mcpPolicy,
            agentType: HARNESS_TEAMMATE_AGENT_TYPE,
          }) satisfies TeamMember
      )
  );
}

function toProvisioningMemberInputs(
  members: readonly TeamMember[],
  fallbackProviderId?: TeamProviderId
): TeamCreateRequest['members'] {
  return cloneFixture(
    members
      .filter((memberValue) => !isLeadMember(memberValue))
      .map((memberValue) => ({
        name: memberValue.name,
        role: memberValue.role,
        workflow: memberValue.workflow,
        isolation: memberValue.isolation,
        cwd: memberValue.cwd,
        providerId: memberValue.providerId,
        providerBackendId: migrateProviderBackendId(
          memberValue.providerId ?? fallbackProviderId,
          memberValue.providerBackendId
        ),
        model: memberValue.model,
        effort: memberValue.effort,
        fastMode: memberValue.fastMode,
        mcpPolicy: memberValue.mcpPolicy,
      }))
  );
}

export function normalizeTeamCreateRequestFixture(request: TeamCreateRequest): TeamCreateRequest {
  const providerId = request.providerId;
  const fixture: TeamCreateRequest = {
    ...cloneFixture(request),
    providerBackendId: migrateProviderBackendId(providerId, request.providerBackendId),
    members: toProvisioningMemberInputs(request.members as readonly TeamMember[], providerId),
  };
  assertNoSecretLikeFixtureValues(fixture);
  return fixture;
}

export function normalizeMembersMetaFixture(members: readonly TeamMember[]): TeamMember[] {
  return members
    .filter((memberValue) => !isLeadMember(memberValue))
    .map((memberValue) => normalizeMemberForConfig(memberValue, false));
}

export type TeamCreateRequestFixtureOptions = Partial<Omit<TeamCreateRequest, 'members'>> & {
  members?: TeamCreateRequest['members'] | readonly TeamMember[];
};

export function makeTeamCreateRequest(
  options: TeamCreateRequestFixtureOptions = {}
): TeamCreateRequest {
  const defaultMembers = [memberFixture.lead(), memberFixture.codex('Builder')];
  const {
    teamName = HARNESS_DEFAULT_TEAM_NAME,
    cwd = HARNESS_INERT_PROJECT_PATH,
    members = defaultMembers,
    ...overrides
  } = options;
  return normalizeTeamCreateRequestFixture({
    teamName,
    cwd,
    members: cloneFixture(members as TeamCreateRequest['members']),
    prompt: 'Harness fixture prompt',
    providerId: 'codex',
    providerBackendId: HARNESS_INERT_PROVIDER_BACKEND_ID,
    model: HARNESS_INERT_MODEL,
    ...overrides,
  });
}
