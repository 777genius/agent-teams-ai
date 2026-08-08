import { describe, expect, it } from 'vitest';

import {
  HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
  parseHostedCreateDraftTeamRequest,
  parseHostedDeleteDraftTeamRequest,
  parseHostedGetSavedTeamRequest,
  parseHostedUpdateDraftTeamRequest,
} from '../../../../src/features/team-configuration/contracts';

const workspaceId = `workspace_${'1'.repeat(32)}`;
const teamId = `team_${'2'.repeat(32)}`;
const idempotencyKey = 'idempotency_team-configuration-create-0001';
const expectedRevision = 'revision_team-configuration-0001';

describe('hosted team configuration contracts', () => {
  it('accepts a bounded create name without treating that mutable name as identity', () => {
    expect(
      parseHostedCreateDraftTeamRequest({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        workspaceId,
        idempotencyKey,
        name: '  Alpha team  ',
        members: [{ name: ' lead ' }, { name: 'reviewer' }],
      })
    ).toEqual({
      ok: true,
      value: {
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        workspaceId,
        idempotencyKey,
        name: 'Alpha team',
        members: [{ name: 'lead' }, { name: 'reviewer' }],
      },
    });

    expect(
      parseHostedCreateDraftTeamRequest({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        workspaceId,
        idempotencyKey,
        name: 'Alpha team',
        cwd: '/untrusted/path',
        members: [{ name: 'lead' }],
      })
    ).toEqual({ ok: false });
  });

  it('requires WorkspaceId and immutable TeamId atomically for every non-create operation', () => {
    const request = {
      schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
      workspaceId,
      teamId,
    };
    expect(parseHostedGetSavedTeamRequest(request)).toEqual({ ok: true, value: request });
    expect(parseHostedGetSavedTeamRequest({ ...request, teamId: undefined })).toEqual({
      ok: false,
    });
    expect(parseHostedGetSavedTeamRequest({ ...request, teamName: 'mutable-name' })).toEqual({
      ok: false,
    });
  });

  it('rejects duplicate or oversized rosters and empty updates', () => {
    const create = {
      schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
      workspaceId,
      idempotencyKey,
      name: 'Alpha',
    };
    expect(parseHostedCreateDraftTeamRequest({ ...create, members: [] })).toEqual({ ok: false });
    expect(
      parseHostedCreateDraftTeamRequest({
        ...create,
        members: [{ name: 'lead' }, { name: 'lead' }],
      })
    ).toEqual({ ok: false });
    expect(
      parseHostedCreateDraftTeamRequest({
        ...create,
        members: Array.from({ length: 33 }, (_, index) => ({ name: `member-${index}` })),
      })
    ).toEqual({ ok: false });
    expect(
      parseHostedUpdateDraftTeamRequest({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        workspaceId,
        teamId,
        expectedRevision,
        updates: {},
      })
    ).toEqual({ ok: false });
  });

  it('trims only the bounded provider-neutral metadata fields', () => {
    const base = {
      schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
      workspaceId,
      teamId,
      expectedRevision,
    };
    expect(
      parseHostedUpdateDraftTeamRequest({
        ...base,
        updates: { name: ' Alpha ', description: ' Draft description ' },
      })
    ).toMatchObject({
      ok: true,
      value: { updates: { name: 'Alpha', description: 'Draft description' } },
    });
    expect(
      parseHostedUpdateDraftTeamRequest({ ...base, updates: { runtime: 'opencode' } })
    ).toEqual({ ok: false });
    expect(
      parseHostedUpdateDraftTeamRequest({
        ...base,
        updates: { description: 'x'.repeat(4_001) },
      })
    ).toEqual({ ok: false });
  });

  it('requires bounded idempotency and revision conflict tokens on mutations', () => {
    const create = {
      schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
      workspaceId,
      idempotencyKey,
      name: 'Alpha',
      members: [{ name: 'lead' }],
    };
    expect(parseHostedCreateDraftTeamRequest(create)).toMatchObject({ ok: true });
    expect(parseHostedCreateDraftTeamRequest({ ...create, idempotencyKey: 'short' })).toEqual({
      ok: false,
    });

    const deletion = {
      schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
      workspaceId,
      teamId,
      expectedRevision,
    };
    expect(parseHostedDeleteDraftTeamRequest(deletion)).toMatchObject({ ok: true });
    expect(parseHostedDeleteDraftTeamRequest({ ...deletion, expectedRevision: undefined })).toEqual(
      {
        ok: false,
      }
    );
  });
});
