// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  HOST_TEAM_HISTORY_MODE_MESSAGE,
  hostTeamSelectionKey,
} from '../../../src/features/agent-backend/contracts';
import { hostTeamRunId } from '../../../src/features/agent-backend/contracts/teamRunSelection';
import {
  createLaunchedHostTeam,
  prepareCreatedHostTeam,
} from '../../../src/features/agent-backend/main/application/createdHostTeam';
import { ForegroundModelChecks } from '../../../src/features/agent-backend/main/application/ForegroundModelChecks';
import { createdTeamSelectionSignature } from '../../../src/shared/utils/createdTeamReadiness';

import type { CapturedTeamCreationPort } from '../../../src/features/agent-backend/main/application/createdHostTeam';
import type { TeamCreateRequest } from '../../../src/shared/types/team';

const draft: TeamCreateRequest = {
  teamName: 'test-created',
  cwd: '/TEST/workspace',
  providerId: 'anthropic',
  model: 'TEST-model',
  prompt: 'original prompt',
  members: [],
};
const snapshot = (ready: boolean) => ({
  preparationId: 'TEST-preparation',
  draftDigest: 'a'.repeat(64),
  ready,
  probes: [
    {
      memberName: 'team-lead',
      commandId: 'TEST-probe',
      model: 'TEST-model',
      phase: ready ? ('completed' as const) : ('running' as const),
      ok: ready,
      expiresAt: Date.now() + 60_000,
    },
  ],
});

describe('captured Create application boundary', () => {
  it.each(['legacy', 'shared'] as const)(
    'prepares and submits the original %s history draft without changing Host settings or command',
    async (history) => {
      const request = {
        ...draft,
        ...(history === 'shared' ? { projectContextMode: 'shared' as const } : {}),
      };
      const target: CapturedTeamCreationPort = {
        prepare: vi.fn(async () => snapshot(true)),
        submit: vi.fn<CapturedTeamCreationPort['submit']>(async (commandId) => ({
          creation: {
            commandId,
            phase: 'published',
            record: {
              contextId: 'local',
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
                  memberId: 'TEST-lead',
                  generation: 'TEST-generation',
                },
              },
            },
          },
          partialCreated: true,
          launch: {
            launchId: 'TEST-launch',
            rosterRevision: 'TEST-roster',
            startedAtMs: null,
            observedAtMs: 1,
            status: 'pending',
            ready: 0,
            expected: 0,
            retryCapability: 'same-binding-no-allocation-only',
            members: [],
          },
        })),
      };
      const checked = await prepareCreatedHostTeam({
        target,
        contextId: 'local',
        preparationId: 'TEST-preparation',
        draft: request,
        guard: { isCurrent: () => true },
      });
      expect(checked.createdTeamReadiness?.selectionSignature).toBe(
        createdTeamSelectionSignature(request)
      );
      const expected = {
        preparationId: 'TEST-preparation',
        draft: {
          contextId: 'local',
          teamName: draft.teamName,
          members: [],
          savedSettings: {
            cwd: draft.cwd,
            providerId: draft.providerId,
            model: draft.model,
            prompt: draft.prompt,
          },
        },
      };
      expect(target.prepare).toHaveBeenNthCalledWith(1, 'prepare', expected);
      expect(target.prepare).toHaveBeenNthCalledWith(2, 'probe.cancel', expected);
      const preparedRequest = {
        ...request,
        command: { commandId: 'TEST-original', idempotencyKey: 'TEST-original' },
        createdTeamReadiness: checked.createdTeamReadiness,
      };
      await expect(
        createLaunchedHostTeam({
          target,
          contextId: 'local',
          request: preparedRequest,
          guard: { isCurrent: () => true },
        })
      ).resolves.toEqual({
        teamName: hostTeamSelectionKey('TEST-handle'),
        runId: hostTeamRunId('TEST-handle', 'TEST-launch', 'TEST-roster'),
        launchStatus: 'unconfirmed',
      });
      expect(target.submit).toHaveBeenCalledExactlyOnceWith('TEST-original', expected);
      const changed = structuredClone(preparedRequest);
      if (history === 'shared') delete changed.projectContextMode;
      else changed.projectContextMode = 'shared';
      await expect(
        createLaunchedHostTeam({
          target,
          contextId: 'local',
          request: changed,
          guard: { isCurrent: () => true },
        })
      ).rejects.toThrow();
      expect(target.submit).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['per_project', 'unknown', null, undefined])(
    'refuses history %s before prepare or submit even with a matching original signature',
    async (projectContextMode) => {
      const target: CapturedTeamCreationPort = { prepare: vi.fn(), submit: vi.fn() };
      const request = { ...draft, projectContextMode };
      const options = { target, contextId: 'local', guard: { isCurrent: () => true } };
      await expect(
        prepareCreatedHostTeam({ ...options, preparationId: 'TEST-preparation', draft: request })
      ).rejects.toMatchObject({
        code: 'invalid',
        outcome: 'not-dispatched',
        message: HOST_TEAM_HISTORY_MODE_MESSAGE,
      });
      await expect(
        createLaunchedHostTeam({
          ...options,
          request: {
            ...request,
            command: { commandId: 'TEST-original', idempotencyKey: 'TEST-original' },
            createdTeamReadiness: {
              preparationId: 'TEST-preparation',
              draftDigest: 'a'.repeat(64),
              expiresAt: Date.now() + 60_000,
              selectionSignature: createdTeamSelectionSignature(request as TeamCreateRequest),
            },
          },
        })
      ).rejects.toMatchObject({
        code: 'invalid',
        outcome: 'not-dispatched',
        message: HOST_TEAM_HISTORY_MODE_MESSAGE,
      });
      expect(target.prepare).not.toHaveBeenCalled();
      expect(target.submit).not.toHaveBeenCalled();
    }
  );
  it('awaits superseded native cleanup, skips intermediate drafts and deduplicates the latest pending check', async () => {
    const checks = new ForegroundModelChecks(),
      effects: string[] = [];
    let releaseOld!: () => void;
    const oldClosing = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const old = checks.run('original', async (current) => {
      effects.push('old admitted');
      await oldClosing;
      expect(current()).toBe(false);
      effects.push('old cleanup complete');
      return { ready: false, message: 'cancelled' };
    });
    const middle = checks.run('intermediate', async () => {
      effects.push('unexpected intermediate admission');
      return { ready: true, message: 'unexpected' };
    });
    const newest = checks.run('latest', async (current) => {
      expect(current()).toBe(true);
      effects.push('latest admitted');
      return { ready: true, message: 'latest' };
    });
    expect(
      checks.run('latest', async () => {
        throw new Error('duplicate admission');
      })
    ).toBe(newest);
    expect(effects).toEqual(['old admitted']);
    releaseOld();
    await old;
    await middle;
    expect((await newest).ready).toBe(true);
    expect(effects).toEqual(['old admitted', 'old cleanup complete', 'latest admitted']);
  });
  it('checks the whole immutable draft without creating Team state and cancels the original probe after context loss', async () => {
    let current = true;
    const calls: string[] = [];
    const target: CapturedTeamCreationPort = {
      prepare: vi.fn(async (action, input) => {
        calls.push(action);
        expect(input.draft.savedSettings.prompt).toBe('original prompt');
        return snapshot(false);
      }),
      submit: vi.fn(async () => {
        throw new Error('unexpected Create effect');
      }),
    };
    const request = structuredClone(draft);
    const checking = prepareCreatedHostTeam({
      target,
      contextId: 'local',
      preparationId: 'TEST-preparation',
      draft: request,
      guard: { isCurrent: () => current },
      wait: async () => {
        current = false;
      },
    });
    request.prompt = 'late mutation';
    await expect(checking).rejects.toThrow();
    expect(calls).toEqual(['prepare', 'probe.cancel']);
    expect(target.submit).not.toHaveBeenCalled();
  });
  it('returns finite scoped proof only for the completed original draft and refuses edited submit before effects', async () => {
    const target: CapturedTeamCreationPort = {
      prepare: vi.fn(async (action) => snapshot(action !== 'prepare')),
      submit: vi.fn(async () => {
        throw new Error('unexpected Create effect');
      }),
    };
    const checked = await prepareCreatedHostTeam({
      target,
      contextId: 'local',
      preparationId: 'TEST-preparation',
      draft,
      guard: { isCurrent: () => true },
      wait: async () => {},
    });
    expect(checked.ready).toBe(true);
    expect(checked.createdTeamReadiness).toMatchObject({
      preparationId: 'TEST-preparation',
      selectionSignature: createdTeamSelectionSignature(draft),
      draftDigest: 'a'.repeat(64),
    });
    await expect(
      createLaunchedHostTeam({
        target,
        contextId: 'local',
        guard: { isCurrent: () => true },
        request: {
          ...draft,
          prompt: 'different product intent',
          command: { commandId: 'TEST-create', idempotencyKey: 'TEST-create' },
          createdTeamReadiness: checked.createdTeamReadiness,
        },
      })
    ).rejects.toThrow();
    expect(target.submit).not.toHaveBeenCalled();
    expect(JSON.stringify(checked)).not.toContain('profileId');
  });
});
