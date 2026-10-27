// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { TeamCreationRefusal } from '../../../src/features/agent-backend/contracts/creation';
import { CapturedTeamRegistry } from '../../../src/features/agent-backend/main/infrastructure/CapturedTeamRegistry';
import { createHostTeamsApi } from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { readTeamCreationResult } from '../../../src/features/agent-backend/renderer/readTeamCreationResult';

import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts';
import type { BackendOwnerBinding } from '../../../src/features/agent-backend/main/application/backendBinding';
import type { TeamsAPI } from '../../../src/shared/types/api';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';

const draft = {
  contextId: 'TEST-local',
  teamName: 'TEST-create',
  savedSettings: { cwd: '/TEST/workspace' },
  members: [],
};
const owner: BackendOwnerBinding = {
  ownerId: 'TEST-owner',
  revision: '1',
  profileId: 'TEST-profile',
  protocolVersion: 1,
  buildId: 'TEST-build',
  storageRoot: '/TEST/store',
  nodeSha256: 'a'.repeat(64),
  hostEntrySha256: 'b'.repeat(64),
};
const published = {
  commandId: 'TEST-original',
  phase: 'published',
  record: {
    contextId: draft.contextId,
    teamId: 'TEST-team',
    teamName: draft.teamName,
    members: [],
    binding: {
      schemaVersion: 1,
      handleId: 'TEST-handle',
      scope: {
        projectId: 'TEST-project',
        workspaceId: 'TEST-workspace',
        teamId: 'TEST-team',
        runId: 'TEST-run',
        memberId: 'TEST-member',
        generation: 'TEST-generation',
      },
    },
  },
};

describe('original Create refusal transport', () => {
  it.each(['invalid', 'conflict', 'forbidden', 'unavailable'] as const)(
    'releases a %s refusal only after the same owner proves no original registry publication',
    async (code) => {
      const request = vi.fn(
        async (method: string, _params: unknown): Promise<JsonValue> =>
          method === 'team.creation.submit'
            ? { ok: false, code, outcome: 'rejected' }
            : { ok: true, value: null }
      );
      const registry = new CapturedTeamRegistry({
        owner,
        client: { request },
        start: async () => {},
        available: () => true,
      });
      await expect(
        registry.submitCreation('TEST-original', { preparationId: 'TEST-preparation', draft })
      ).rejects.toMatchObject({ code, outcome: 'rejected', name: 'TeamCreationRefusal' });
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        'team.creation.submit',
        'team.registry.lookup',
      ]);
      expect(request.mock.calls[1]![1]).toMatchObject({
        owner,
        commandId: 'TEST-original',
        payload: { contextId: draft.contextId, expected: draft },
      });
    }
  );

  it.each(['pending', 'published', 'held'] as const)(
    'keeps a launch refusal UNKNOWN when the original registry intent is %s',
    async (phase) => {
      const request = vi.fn(
        async (method: string, _params: unknown): Promise<JsonValue> =>
          method === 'team.creation.submit'
            ? { ok: false, code: 'conflict', outcome: 'rejected' }
            : { ok: true, value: { ...published, phase } }
      );
      const registry = new CapturedTeamRegistry({
        owner,
        client: { request },
        start: async () => {},
        available: () => true,
      });
      await expect(
        registry.submitCreation('TEST-original', { preparationId: 'TEST-preparation', draft })
      ).rejects.toMatchObject({ code: 'hold', outcome: 'unknown' });
      expect(request).toHaveBeenCalledTimes(2);
    }
  );

  it('keeps UNKNOWN when original context authority changes during the registry absence read', async () => {
    let current = true;
    const request = vi.fn(async (method: string, _params: unknown): Promise<JsonValue> => {
      if (method === 'team.creation.submit')
        return { ok: false, code: 'conflict', outcome: 'rejected' };
      current = false;
      return { ok: true, value: null };
    });
    const registry = new CapturedTeamRegistry({
      owner,
      client: { request },
      start: async () => {},
      available: () => true,
    });
    await expect(
      registry.submitCreation(
        'TEST-original',
        { preparationId: 'TEST-preparation', draft },
        { isCurrent: () => current }
      )
    ).rejects.toMatchObject({ code: 'forbidden', outcome: 'unknown' });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'team.creation.submit',
      'team.registry.lookup',
    ]);
  });

  it('never promotes UNKNOWN or a missing/failed original lookup to a definitive refusal', async () => {
    for (const refusal of [
      { ok: false, code: 'conflict', outcome: 'unknown' },
      { ok: false, code: 'hold', outcome: 'unknown' },
      { ok: false, code: 'conflict', outcome: 'rejected' },
    ]) {
      const request = vi.fn(
        async (method: string, _params: unknown): Promise<JsonValue> =>
          method === 'team.creation.submit'
            ? refusal
            : method === 'team.registry.lookup'
              ? { ok: false, code: 'hold', outcome: 'unknown' }
              : { ok: true, value: null }
      );
      const registry = new CapturedTeamRegistry({
        owner,
        client: { request },
        start: async () => {},
        available: () => true,
      });
      await expect(
        registry.submitCreation('TEST-original', { preparationId: 'TEST-preparation', draft })
      ).rejects.not.toBeInstanceOf(TeamCreationRefusal);
      expect(
        request.mock.calls.filter(([method]) => method === 'team.creation.submit')
      ).toHaveLength(1);
    }
  });

  it('uses the raw existing Create bridge through the ordinary renderer adapter without losing refusal metadata', async () => {
    const failure = { kind: 'captured-team-create-refusal', code: 'conflict', outcome: 'rejected' };
    const createTeamResult = vi.fn(async () => ({ success: false, failure }));
    const legacyCreate = vi.fn();
    const teams = createHostTeamsApi(
      { createTeam: legacyCreate, createTeamResult } as unknown as TeamsAPI,
      {} as AgentBackendApi
    );
    const request = {
      teamName: 'TEST-create',
      cwd: '/TEST/workspace',
      members: [],
      command: {
        commandId: 'TEST-original',
        idempotencyKey: 'TEST-original',
      },
    };
    await expect(teams.createTeam(request)).rejects.toBeInstanceOf(TeamCreationRefusal);
    expect(createTeamResult).toHaveBeenCalledWith(request);
    expect(legacyCreate).not.toHaveBeenCalled();
  });

  it('reconstructs only the finite structured refusal after the raw contextBridge result', () => {
    const failure = { kind: 'captured-team-create-refusal', code: 'conflict', outcome: 'rejected' };
    expect(() => readTeamCreationResult({ success: false, failure })).toThrow(TeamCreationRefusal);
    for (const value of [
      undefined,
      { ...failure, outcome: 'unknown' },
      { ...failure, nativePath: '/private' },
      { ...failure, code: 'raw private detail' },
    ]) {
      try {
        readTeamCreationResult({ success: false, failure: value });
      } catch (error) {
        expect(error).not.toBeInstanceOf(TeamCreationRefusal);
      }
    }
    const result = { runId: 'TEST-run', teamName: 'host-team:TEST-handle' };
    expect(readTeamCreationResult({ success: true, data: result })).toEqual(result);
  });
});
