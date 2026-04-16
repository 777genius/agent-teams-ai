import { describe, expect, it } from 'vitest';

import { resolveMemberRuntimeSummary } from '@renderer/utils/memberRuntimeSummary';

import type { MemberSpawnStatusEntry, ResolvedTeamMember } from '@shared/types';

function createMember(overrides: Partial<ResolvedTeamMember> = {}): ResolvedTeamMember {
  return {
    name: 'alice',
    agentId: 'alice@test-team',
    agentType: 'general-purpose',
    role: 'developer',
    providerId: 'codex',
    effort: 'medium',
    status: 'idle',
    currentTaskId: null,
    taskCount: 0,
    lastActiveAt: null,
    messageCount: 0,
    color: 'blue',
    ...overrides,
  };
}

function createSpawnEntry(overrides: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry {
  return {
    status: 'waiting',
    launchState: 'starting',
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    agentToolAccepted: true,
    updatedAt: '2026-04-16T17:10:48.646Z',
    ...overrides,
  };
}

describe('resolveMemberRuntimeSummary', () => {
  it('shows the live runtime model for loading members when available', () => {
    const member = createMember();
    const spawnEntry = createSpawnEntry({ runtimeModel: 'claude-opus-4-6', runtimeAlive: true });

    expect(resolveMemberRuntimeSummary(member, undefined, spawnEntry)).toBe(
      'Anthropic · Opus 4.6 · Medium'
    );
  });

  it('keeps the loading skeleton when a pending member has no live runtime model yet', () => {
    const member = createMember();
    const spawnEntry = createSpawnEntry();

    expect(resolveMemberRuntimeSummary(member, undefined, spawnEntry)).toBeUndefined();
  });

  it('uses the live runtime model as a fallback when config has no explicit model', () => {
    const member = createMember({ providerId: 'codex', model: undefined });
    const spawnEntry = createSpawnEntry({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      runtimeModel: 'gpt-5.4-mini',
    });

    expect(resolveMemberRuntimeSummary(member, undefined, spawnEntry)).toBe('5.4 Mini · Medium');
  });
});
