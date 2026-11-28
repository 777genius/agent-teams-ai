// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  createLaunchedHostTeam,
  prepareCreatedHostTeam,
} from '../../../src/features/agent-backend/main/application/createdHostTeam';
import { createdTeamSelectionSignature } from '../../../src/shared/utils/createdTeamReadiness';
import { ForegroundModelChecks } from '../../../src/features/agent-backend/main/application/ForegroundModelChecks';

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
