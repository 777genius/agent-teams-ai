import { describe, expect, it } from 'vitest';

import {
  getRuntimeMemorySourceLabel,
  resolveMemberRuntimeSummary,
} from '@renderer/utils/memberRuntimeSummary';

import type { MemberSpawnStatusEntry, ResolvedTeamMember } from '@shared/types';

type TestResolvedTeamMember = ResolvedTeamMember & { providerBackendId?: string };

function createMember(overrides: Partial<TestResolvedTeamMember> = {}): TestResolvedTeamMember {
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
    const spawnEntry = createSpawnEntry({ runtimeModel: 'claude-opus-4-7', runtimeAlive: true });

    expect(resolveMemberRuntimeSummary(member, undefined, spawnEntry)).toBe(
      'Anthropic · Opus 4.7 · Medium · Codex'
    );
  });

  it('keeps the configured summary visible while a pending member waits for the live runtime model', () => {
    const member = createMember({ model: 'gpt-5.4-mini' });
    const spawnEntry = createSpawnEntry();

    expect(resolveMemberRuntimeSummary(member, undefined, spawnEntry)).toBe(
      '5.4 Mini · Medium · Codex'
    );
  });

  it('still keeps the loading skeleton when a pending member has neither live nor configured model truth', () => {
    const member = createMember({ model: undefined });
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

    expect(resolveMemberRuntimeSummary(member, undefined, spawnEntry)).toBe(
      '5.4 Mini · Medium · Codex'
    );
  });

  it('appends runtime memory when a live process snapshot is available', () => {
    const member = createMember({ model: 'gpt-5.4-mini' });
    const runtimeEntry = {
      memberName: 'alice',
      alive: true,
      restartable: true,
      pid: 4242,
      runtimeModel: 'gpt-5.4-mini',
      rssBytes: 256 * 1024 * 1024,
      updatedAt: '2026-04-18T18:00:00.000Z',
    };

    expect(resolveMemberRuntimeSummary(member, undefined, undefined, runtimeEntry)).toBe(
      '5.4 Mini · Medium · Codex · 256.0 MB'
    );
  });

  it('appends runtime memory while a configured member is still pending', () => {
    const member = createMember({ model: 'gpt-5.4-mini' });
    const spawnEntry = createSpawnEntry();
    const runtimeEntry = {
      memberName: 'alice',
      alive: true,
      restartable: true,
      pid: 4242,
      rssBytes: 256 * 1024 * 1024,
      updatedAt: '2026-04-18T18:00:00.000Z',
    };

    expect(resolveMemberRuntimeSummary(member, undefined, spawnEntry, runtimeEntry as never)).toBe(
      '5.4 Mini · Medium · Codex · 256.0 MB'
    );
  });

  it('keeps the persisted backend lane visible in the runtime summary', () => {
    const member = createMember({ model: 'gpt-5.4-mini' });

    expect(
      resolveMemberRuntimeSummary(
        member,
        {
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4-mini',
          effort: 'medium',
          limitContext: false,
        },
        undefined
      )
    ).toBe('5.4 Mini · Medium · Codex');
  });

  it('normalizes persisted legacy Codex lanes to the native runtime summary', () => {
    const member = createMember({ model: 'gpt-5.4-mini' });

    expect(
      resolveMemberRuntimeSummary(
        member,
        {
          providerId: 'codex',
          providerBackendId: 'api',
          model: 'gpt-5.4-mini',
          effort: 'medium',
          limitContext: false,
        },
        undefined
      )
    ).toBe('5.4 Mini · Medium · Codex');
  });

  it('does not leak the lead backend label into OpenCode side-lane members', () => {
    const member = createMember({
      providerId: 'opencode',
      providerBackendId: undefined,
      model: 'opencode/nemotron-3-super-free',
      effort: undefined,
    });

    expect(
      resolveMemberRuntimeSummary(
        member,
        {
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'medium',
          limitContext: false,
        },
        undefined
      )
    ).toBe('nemotron-3-super-free · via OpenCode');
  });

  it('infers OpenCode from an OpenCode model when member provider metadata is missing', () => {
    const member = createMember({
      providerId: undefined,
      providerBackendId: undefined,
      model: 'opencode/minimax-m2.5-free',
      effort: undefined,
    });

    expect(
      resolveMemberRuntimeSummary(
        member,
        {
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'medium',
          limitContext: false,
        },
        undefined
      )
    ).toBe('minimax-m2.5-free · via OpenCode');
  });

  it('appends memory for OpenCode side-lane runtime snapshots without adding Codex backend text', () => {
    const member = createMember({
      providerId: 'opencode',
      providerBackendId: undefined,
      model: 'opencode/minimax-m2.5-free',
      effort: undefined,
    });

    expect(
      resolveMemberRuntimeSummary(
        member,
        {
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'medium',
          limitContext: false,
        },
        undefined,
        {
          memberName: 'alice',
          alive: true,
          restartable: false,
          runtimeModel: 'opencode/minimax-m2.5-free',
          rssBytes: 183.9 * 1024 * 1024,
          updatedAt: '2026-04-18T18:00:00.000Z',
        }
      )
    ).toBe('minimax-m2.5-free · via OpenCode · 183.9 MB');
  });
});

describe('getRuntimeMemorySourceLabel', () => {
  it('explains when RSS comes from a tmux pane shell', () => {
    expect(
      getRuntimeMemorySourceLabel({
        memberName: 'alice',
        alive: false,
        restartable: true,
        pid: 26676,
        pidSource: 'tmux_pane',
        rssBytes: 2 * 1024 * 1024,
        updatedAt: '2026-04-24T12:00:00.000Z',
      })
    ).toBe('RSS source: tmux pane shell');
  });

  it('explains shared OpenCode host memory separately from member-owned runtime memory', () => {
    expect(
      getRuntimeMemorySourceLabel({
        memberName: 'alice',
        alive: true,
        restartable: false,
        providerId: 'opencode',
        pid: 333,
        pidSource: 'opencode_bridge',
        rssBytes: 183.9 * 1024 * 1024,
        updatedAt: '2026-04-24T12:00:00.000Z',
      })
    ).toBe('RSS source: shared OpenCode host');
  });

  it('labels verified runtime child memory as runtime process memory', () => {
    expect(
      getRuntimeMemorySourceLabel({
        memberName: 'alice',
        alive: true,
        restartable: true,
        pid: 4242,
        pidSource: 'tmux_child',
        rssBytes: 256 * 1024 * 1024,
        updatedAt: '2026-04-24T12:00:00.000Z',
      })
    ).toBe('RSS source: runtime process');
  });
});
