import { describe, expect, it } from 'vitest';

import {
  HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
  parseHostedCreateDraftTeamRequest,
  parseHostedDeleteDraftTeamRequest,
  parseHostedGetSavedTeamRequest,
  parseHostedRosterConfiguration,
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

const configuration = {
  schemaVersion: 1,
  toolApprovalMode: 'manual',
  lanes: [{ kind: 'opencode', provider: 'opencode', selectedModel: 'openai/gpt-5', effort: 'high',
    members: [{ name: 'lead', prompt: 'Coordinate the work.' }] }],
} as const;

function configuredCreate(config: unknown = configuration) {
  return parseHostedCreateDraftTeamRequest({ schemaVersion: 1, workspaceId, idempotencyKey,
    name: 'Configured', members: [{ name: 'lead' }], configuration: config });
}

describe('hosted initial roster configuration', () => {
  it('retains explicit manual approval and ordered configuration without asserting readiness', () => {
    expect(configuredCreate()).toMatchObject({ ok: true, value: { configuration } });
    const parsed = parseHostedRosterConfiguration(configuration);
    expect(parsed).toEqual(configuration);
    expect(parsed).not.toBe(configuration);
    expect(Object.isFrozen(parsed.lanes[0].members[0])).toBe(true);
    expect(parsed).not.toHaveProperty('ready');
    expect(configuredCreate({ ...configuration, toolApprovalMode: undefined })).toEqual({ ok: false });
    expect(configuredCreate({ ...configuration, toolApprovalMode: 'auto' })).toMatchObject({
      ok: true, value: { configuration: { toolApprovalMode: 'auto' } },
    });
  });

  it.each(['workspaceRoot', 'cwd', 'legacyKey', 'executable', 'argv', 'environment', 'socket',
    'ownerGeneration', 'grants', 'checksum', 'laneId'])('rejects browser-owned %s at every nested boundary', (field) => {
    expect(configuredCreate({ ...configuration, [field]: 'untrusted' })).toEqual({ ok: false });
    const lane = configuration.lanes[0];
    expect(configuredCreate({ ...configuration, lanes: [{ ...lane, [field]: 'untrusted' }] })).toEqual({ ok: false });
    expect(configuredCreate({ ...configuration, lanes: [{ ...lane,
      members: [{ ...lane.members[0], [field]: 'untrusted' }] }] })).toEqual({ ok: false });
  });

  it.each(['user', 'USER', 'team-lead', 'con', 'aux.txt', 'alice-2', 'alice-provisioner'])('rejects reserved member %s', (name) => {
    expect(() => parseHostedRosterConfiguration({ ...configuration,
      lanes: [{ ...configuration.lanes[0], members: [{ name, prompt: 'Work.' }] }],
    })).toThrow();
  });

  it('rejects case collisions across lanes, roster projection disagreement and unsupported selections', () => {
    const lane = configuration.lanes[0];
    expect(() => parseHostedRosterConfiguration({ ...configuration, lanes: [lane,
      { ...lane, members: [{ name: 'LEAD', prompt: 'Work.' }] }],
    })).toThrow();
    expect(configuredCreate({ ...configuration, lanes: [{ ...lane,
      members: [{ name: 'different', prompt: 'Work.' }] }] })).toEqual({ ok: false });
    for (const patch of [{ provider: 'unknown' }, { kind: 'native' }, { effort: 'ultra' },
      { selectedModel: 'unqualified' }, { selectedModel: 'openai/model with spaces' }]) {
      expect(configuredCreate({ ...configuration, lanes: [{ ...lane, ...patch }] })).toEqual({ ok: false });
    }
  });

  it('describes native selections without admitting native execution or inventing models', () => {
    for (const provider of ['anthropic', 'codex', 'gemini']) {
      const lane = { kind: 'native', provider, members: [{ name: 'lead', prompt: 'Work.', model: 'selected-model', effort: 'high' }] };
      expect(configuredCreate({ ...configuration, lanes: [lane] })).toMatchObject({ ok: true });
      expect(configuredCreate({ ...configuration, lanes: [{ ...lane, members: [{ name: 'lead', prompt: 'Work.' }] }] })).toEqual({ ok: false });
    }
  });

  it('bounds UTF-8 prompts, total serialized bytes and member/lane counts', () => {
    const lane = configuration.lanes[0];
    for (const prompt of ['', ' padded ', 'x\0y', 'é'.repeat(32769)]) {
      expect(configuredCreate({ ...configuration, lanes: [{ ...lane, members: [{ name: 'lead', prompt }] }] })).toEqual({ ok: false });
    }
    expect(() => parseHostedRosterConfiguration({ ...configuration, lanes: [{ ...lane,
      members: ['alpha', 'beta', 'gamma', 'delta'].map((name) => ({ name, prompt: 'x'.repeat(64000) })) }],
    })).toThrow();
    expect(configuredCreate({ ...configuration, lanes: [] })).toEqual({ ok: false });
    expect(configuredCreate({ ...configuration, lanes: new Array(1) })).toEqual({ ok: false });
    expect(configuredCreate({ ...configuration, lanes: [{ ...lane, members: new Array(1) }] })).toEqual({ ok: false });
    expect(configuredCreate({ ...configuration, lanes: Array(33).fill(lane) })).toEqual({ ok: false });
    expect(configuredCreate({ ...configuration, lanes: [{ ...lane, members: [] }] })).toEqual({ ok: false });
  });

  it('requires revisions for replacement and rejects removal or partial configuration', () => {
    const base = { schemaVersion: 1, workspaceId, teamId, expectedRevision };
    expect(parseHostedUpdateDraftTeamRequest({ ...base, updates: { configuration } })).toMatchObject({ ok: true, value: { updates: { configuration } } });
    for (const invalid of [null, undefined, {}, { toolApprovalMode: 'auto' }]) {
      expect(parseHostedUpdateDraftTeamRequest({ ...base, updates: { configuration: invalid } })).toEqual({ ok: false });
    }
    expect(parseHostedUpdateDraftTeamRequest({ ...base, expectedRevision: undefined, updates: { configuration } })).toEqual({ ok: false });
  });
});
