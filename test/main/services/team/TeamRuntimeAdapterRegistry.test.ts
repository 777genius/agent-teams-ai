import { describe, expect, it, vi } from 'vitest';

import {
  isTeamRuntimeProviderId,
  TeamRuntimeAdapterRegistry,
  type TeamLaunchRuntimeAdapter,
  type TeamRuntimeProviderId,
} from '../../../../src/main/services/team/runtime';

describe('TeamRuntimeAdapterRegistry', () => {
  it('registers and returns provider-specific runtime adapters', async () => {
    const adapter = fakeAdapter('opencode');
    const registry = new TeamRuntimeAdapterRegistry([adapter]);

    expect(registry.has('opencode')).toBe(true);
    expect(registry.get('opencode')).toBe(adapter);
    expect(registry.providers()).toEqual(['opencode']);

    await expect(
      registry.get('opencode').prepare({
        runId: 'run-1',
        teamName: 'team-a',
        cwd: '/repo',
        providerId: 'opencode',
        skipPermissions: false,
        expectedMembers: [
          {
            name: 'alice',
            providerId: 'opencode',
            cwd: '/repo',
          },
        ],
        previousLaunchState: null,
      })
    ).resolves.toMatchObject({
      ok: true,
      providerId: 'opencode',
      modelId: 'opencode/default',
    });
  });

  it('fails fast on duplicate providers', () => {
    const registry = new TeamRuntimeAdapterRegistry([fakeAdapter('anthropic')]);

    expect(() => registry.register(fakeAdapter('anthropic'))).toThrow(
      'Runtime adapter already registered: anthropic'
    );
  });

  it('fails fast when a requested provider has no adapter', () => {
    const registry = new TeamRuntimeAdapterRegistry([fakeAdapter('codex')]);

    expect(registry.has('gemini')).toBe(false);
    expect(() => registry.get('gemini')).toThrow(
      'Runtime adapter is not available for provider gemini'
    );
  });

  it('defensively rejects invalid adapter provider ids at runtime', () => {
    const registry = new TeamRuntimeAdapterRegistry();
    const adapter = fakeAdapter('opencode') as unknown as TeamLaunchRuntimeAdapter & {
      providerId: string;
    };
    (adapter as { providerId: string }).providerId = 'unknown';

    expect(() => registry.register(adapter as TeamLaunchRuntimeAdapter)).toThrow(
      'Invalid runtime adapter provider: unknown'
    );
  });

  it('returns a copy of registered provider ids', () => {
    const registry = new TeamRuntimeAdapterRegistry([fakeAdapter('codex')]);
    const providers = registry.providers();
    providers.push('opencode');

    expect(registry.providers()).toEqual(['codex']);
  });
});

describe('isTeamRuntimeProviderId', () => {
  it('accepts OpenCode as a first-class runtime provider id', () => {
    expect(isTeamRuntimeProviderId('anthropic')).toBe(true);
    expect(isTeamRuntimeProviderId('codex')).toBe(true);
    expect(isTeamRuntimeProviderId('gemini')).toBe(true);
    expect(isTeamRuntimeProviderId('opencode')).toBe(true);
    expect(isTeamRuntimeProviderId('open-code')).toBe(false);
  });
});

function fakeAdapter(providerId: TeamRuntimeProviderId): TeamLaunchRuntimeAdapter {
  return {
    providerId,
    prepare: vi.fn(async (_input) => ({
      ok: true as const,
      providerId,
      modelId: `${providerId}/default`,
      diagnostics: [],
      warnings: [],
    })),
    launch: vi.fn(async (input) => ({
      runId: input.runId,
      teamName: input.teamName,
      launchPhase: 'active' as const,
      teamLaunchState: 'partial_pending' as const,
      members: {},
      warnings: [],
      diagnostics: [],
    })),
    reconcile: vi.fn(async (input) => ({
      runId: input.runId,
      teamName: input.teamName,
      launchPhase: 'reconciled' as const,
      teamLaunchState: 'partial_pending' as const,
      members: {},
      snapshot: input.previousLaunchState,
      warnings: [],
      diagnostics: [],
    })),
    stop: vi.fn(async (input) => ({
      runId: input.runId,
      teamName: input.teamName,
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: [],
    })),
  };
}
