import {
  parseTeamId,
  parseWorkspaceId,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted';
import { expectTypeOf } from 'vitest';

const TEAM_ID = 'team_0123456789abcdef0123456789abcdef';
const WORKSPACE_ID = 'workspace_fedcba9876543210fedcba9876543210';

describe('canonical hosted identifiers', () => {
  it('keeps TeamId and WorkspaceId opaque and kind-separated', () => {
    const teamId = parseTeamId(TEAM_ID);
    const workspaceId = parseWorkspaceId(WORKSPACE_ID);

    expectTypeOf(teamId).toEqualTypeOf<TeamId>();
    expectTypeOf(workspaceId).toEqualTypeOf<WorkspaceId>();
    expectTypeOf<TeamId>().not.toEqualTypeOf<WorkspaceId>();
    expect(teamId).toBe(TEAM_ID);
    expect(workspaceId).toBe(WORKSPACE_ID);
    expect(() => parseTeamId(workspaceId)).toThrow('hosted-contract-canonical-identifier-invalid');
    expect(() => parseWorkspaceId(teamId)).toThrow('hosted-contract-canonical-identifier-invalid');
  });

  it('survives JSON serialization and reparsing byte-for-byte', () => {
    const teamId = parseTeamId(TEAM_ID);
    const workspaceId = parseWorkspaceId(WORKSPACE_ID);
    const serialized = JSON.stringify({ teamId, workspaceId });
    const reparsed = JSON.parse(serialized) as Record<string, unknown>;

    expect(parseTeamId(reparsed.teamId)).toBe(TEAM_ID);
    expect(parseWorkspaceId(reparsed.workspaceId)).toBe(WORKSPACE_ID);
    expect(JSON.stringify(reparsed)).toBe(serialized);
  });

  it.each([
    undefined,
    null,
    1,
    '',
    'team_0123456789abcdef0123456789abcde',
    'team_0123456789abcdef0123456789abcdef0',
    'team_0123456789ABCDEF0123456789ABCDEF',
    ' team_0123456789abcdef0123456789abcdef',
    'team_0123456789abcdef0123456789abcdef ',
    'team_0123456789abcdef 123456789abcdef',
    'team_platform',
    'Platform Team',
    'team_../0123456789abcdef0123456789ab',
    'team_/srv/agent-teams/identity-token',
    'team_C:\\agent-teams\\identity-token',
    WORKSPACE_ID,
  ])(
    'rejects invalid, whitespace-bearing, name-like, path-like, or cross-kind TeamId %j',
    (value) => {
      expect(() => parseTeamId(value)).toThrow('hosted-contract-canonical-identifier-invalid');
    }
  );

  it.each([
    undefined,
    null,
    1,
    '',
    'workspace_fedcba9876543210fedcba987654321',
    'workspace_fedcba9876543210fedcba98765432100',
    'workspace_FEDCBA9876543210FEDCBA9876543210',
    '\tworkspace_fedcba9876543210fedcba9876543210',
    'workspace_fedcba9876543210fedcba9876543210\n',
    'workspace_fedcba987654 210fedcba9876543210',
    'workspace_primary',
    'Primary Workspace',
    'workspace_../fedcba9876543210fedcba987654',
    'workspace_/srv/agent-teams/identity-token',
    'workspace_C:\\agent-teams\\identity-token',
    TEAM_ID,
  ])(
    'rejects invalid, whitespace-bearing, name-like, path-like, or cross-kind WorkspaceId %j',
    (value) => {
      expect(() => parseWorkspaceId(value)).toThrow('hosted-contract-canonical-identifier-invalid');
    }
  );
});
