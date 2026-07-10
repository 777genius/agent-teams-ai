import {
  HARNESS_DEFAULT_NOW_ISO,
  HARNESS_DEFAULT_TEAM_NAME,
  HARNESS_INERT_MODEL,
  HARNESS_INERT_PROJECT_PATH,
  HARNESS_INERT_PROVIDER_BACKEND_ID,
} from './fixtureConstants';
import { assertNoSecretLikeFixtureValues } from './fixtureSecrets';
import { cloneFixture } from './harnessData';

import type { TeamMetaFile } from '@main/services/team/TeamMetaStore';
import type {
  TeamConfig,
  TeamCreateRequest,
  TeamMember,
  TeamProviderId,
} from '@shared/types';

export type MemberFixtureOptions = Partial<TeamMember>;

function member(
  name: string,
  providerId: TeamProviderId,
  role: string,
  overrides: MemberFixtureOptions = {}
): TeamMember {
  const fixture: TeamMember = {
    name,
    role,
    providerId,
    providerBackendId: HARNESS_INERT_PROVIDER_BACKEND_ID,
    model: HARNESS_INERT_MODEL,
    ...overrides,
  };
  assertNoSecretLikeFixtureValues(fixture);
  return cloneFixture(fixture);
}

export const memberFixture = {
  lead(overrides: MemberFixtureOptions = {}): TeamMember {
    return member('Lead', 'codex', 'Team Lead', overrides);
  },

  codex(name: string, overrides: MemberFixtureOptions = {}): TeamMember {
    return member(name, 'codex', 'Engineer', overrides);
  },

  anthropic(name: string, overrides: MemberFixtureOptions = {}): TeamMember {
    return member(name, 'anthropic', 'Engineer', overrides);
  },

  opencode(name: string, overrides: MemberFixtureOptions = {}): TeamMember {
    return member(name, 'opencode', 'Engineer', overrides);
  },
};

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

    const fixture: TeamConfig = {
      name: overrides.name ?? teamName,
      description: 'Harness fixture team',
      color: 'blue',
      projectPath,
      leadSessionId: 'harness-lead-session',
      members,
      ...overrides,
    };
    assertNoSecretLikeFixtureValues(fixture);
    return cloneFixture(fixture);
  },
};

export type TeamMetaFixtureOptions = Partial<Omit<TeamMetaFile, 'version'>>;

export const teamMetaFixture = {
  basic(options: TeamMetaFixtureOptions = {}): TeamMetaFile {
    const fixture: TeamMetaFile = {
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
    assertNoSecretLikeFixtureValues(fixture);
    return cloneFixture(fixture);
  },
};

export function toMetaMembers(members: TeamCreateRequest['members']): TeamMember[] {
  return cloneFixture(
    members.map(
      (memberValue) =>
        ({
          name: memberValue.name,
          role: memberValue.role,
          workflow: memberValue.workflow,
          isolation: memberValue.isolation,
          cwd: memberValue.cwd,
          providerId: memberValue.providerId,
          model: memberValue.model,
          effort: memberValue.effort,
          mcpPolicy: memberValue.mcpPolicy,
          agentType: 'teammate',
        }) satisfies TeamMember
    )
  );
}

function toProvisioningMemberInputs(members: readonly TeamMember[]): TeamCreateRequest['members'] {
  return cloneFixture(
    members.map((memberValue) => ({
      name: memberValue.name,
      role: memberValue.role,
      workflow: memberValue.workflow,
      isolation: memberValue.isolation,
      cwd: memberValue.cwd,
      providerId: memberValue.providerId,
      providerBackendId: memberValue.providerBackendId,
      model: memberValue.model,
      effort: memberValue.effort,
      fastMode: memberValue.fastMode,
      mcpPolicy: memberValue.mcpPolicy,
    }))
  );
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
  const request: TeamCreateRequest = {
    teamName,
    cwd,
    members: toProvisioningMemberInputs(members as readonly TeamMember[]),
    prompt: 'Harness fixture prompt',
    providerId: 'codex',
    providerBackendId: HARNESS_INERT_PROVIDER_BACKEND_ID,
    model: HARNESS_INERT_MODEL,
    ...overrides,
  };
  assertNoSecretLikeFixtureValues(request);
  return cloneFixture(request);
}
