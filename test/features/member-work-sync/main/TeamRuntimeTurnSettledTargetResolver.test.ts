import { TeamRuntimeTurnSettledTargetResolver } from '@features/member-work-sync/main/adapters/output/TeamRuntimeTurnSettledTargetResolver';
import { describe, expect, it, vi } from 'vitest';

import type { TeamConfig } from '@shared/types';

describe('TeamRuntimeTurnSettledTargetResolver', () => {
  it('resolves a Claude Stop transcript path to an active Anthropic teammate', async () => {
    const resolver = new TeamRuntimeTurnSettledTargetResolver({
      teamSource: {
        listTeams: vi.fn(async () => [{ teamName: 'team-a', displayName: 'team-a' } as never]),
        getConfig: vi.fn(async () => ({
          name: 'team-a',
          members: [{ name: 'Alice', providerId: 'anthropic' }],
        }) satisfies TeamConfig),
      },
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
      memberLogsFinder: {
        listAttributedMemberFiles: vi.fn(async () => [
          {
            memberName: 'Alice',
            sessionId: 'ses-1',
            filePath: '/tmp/ses-1.jsonl',
            mtimeMs: 1,
          },
        ]),
      },
    });

    await expect(
      resolver.resolve({
        schemaVersion: 1,
        provider: 'claude',
        hookEventName: 'Stop',
        sourceId: 'source-1',
        payloadHash: 'hash',
        recordedAt: '2026-04-29T12:00:00.000Z',
        sessionId: 'ses-1',
        transcriptPath: '/tmp/ses-1.jsonl',
      })
    ).resolves.toEqual({ ok: true, teamName: 'team-a', memberName: 'alice' });
  });

  it('rejects matches for removed or non-Anthropic teammates', async () => {
    const resolver = new TeamRuntimeTurnSettledTargetResolver({
      teamSource: {
        listTeams: vi.fn(async () => [{ teamName: 'team-a', displayName: 'team-a' } as never]),
        getConfig: vi.fn(async () => ({
          name: 'team-a',
          members: [{ name: 'bob', providerId: 'opencode' }],
        }) satisfies TeamConfig),
      },
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
      memberLogsFinder: {
        listAttributedMemberFiles: vi.fn(async () => [
          {
            memberName: 'bob',
            sessionId: 'ses-1',
            filePath: '/tmp/ses-1.jsonl',
            mtimeMs: 1,
          },
        ]),
      },
    });

    await expect(
      resolver.resolve({
        schemaVersion: 1,
        provider: 'claude',
        hookEventName: 'Stop',
        sourceId: 'source-1',
        payloadHash: 'hash',
        recordedAt: '2026-04-29T12:00:00.000Z',
        sessionId: 'ses-1',
      })
    ).resolves.toEqual({ ok: false, reason: 'provider_mismatch' });
  });

  it('resolves Codex native turn-settled payloads from durable team/member identity', async () => {
    const resolver = new TeamRuntimeTurnSettledTargetResolver({
      teamSource: {
        listTeams: vi.fn(async () => {
          throw new Error('codex path should not scan attributed files');
        }),
        getConfig: vi.fn(async () => ({
          name: 'team-a',
          members: [{ name: 'Jack', providerId: 'codex' }],
        }) satisfies TeamConfig),
      },
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
      memberLogsFinder: {
        listAttributedMemberFiles: vi.fn(async () => []),
      },
    });

    await expect(
      resolver.resolve({
        schemaVersion: 1,
        provider: 'codex',
        hookEventName: 'Stop',
        sourceId: 'source-1',
        payloadHash: 'hash',
        recordedAt: '2026-04-29T12:00:00.000Z',
        sessionId: 'ses-1',
        teamName: 'team-a',
        memberName: 'jack',
      })
    ).resolves.toEqual({ ok: true, teamName: 'team-a', memberName: 'jack' });
  });

  it('rejects Codex native events for non-Codex teammates', async () => {
    const resolver = new TeamRuntimeTurnSettledTargetResolver({
      teamSource: {
        listTeams: vi.fn(async () => []),
        getConfig: vi.fn(async () => ({
          name: 'team-a',
          members: [{ name: 'Jack', providerId: 'anthropic' }],
        }) satisfies TeamConfig),
      },
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
    });

    await expect(
      resolver.resolve({
        schemaVersion: 1,
        provider: 'codex',
        hookEventName: 'Stop',
        sourceId: 'source-1',
        payloadHash: 'hash',
        recordedAt: '2026-04-29T12:00:00.000Z',
        sessionId: 'ses-1',
        teamName: 'team-a',
        memberName: 'jack',
      })
    ).resolves.toEqual({ ok: false, reason: 'provider_mismatch' });
  });

  it('preserves config provider metadata when member meta lacks provider fields', async () => {
    const resolver = new TeamRuntimeTurnSettledTargetResolver({
      teamSource: {
        listTeams: vi.fn(async () => []),
        getConfig: vi.fn(async () => ({
          name: 'team-a',
          members: [
            {
              name: 'Jack',
              providerBackendId: 'codex-native',
              model: 'opencode/openai/gpt-oss',
            },
          ],
        }) satisfies TeamConfig),
      },
      membersMetaStore: {
        getMembers: vi.fn(async () => [
          {
            name: 'Jack',
            role: 'developer',
            agentType: 'general-purpose',
            color: 'blue',
          },
        ]),
      } as never,
    });

    await expect(
      resolver.resolve({
        schemaVersion: 1,
        provider: 'opencode',
        hookEventName: 'Stop',
        sourceId: 'source-1',
        payloadHash: 'hash',
        recordedAt: '2026-04-29T12:00:00.000Z',
        sessionId: 'ses-1',
        teamName: 'team-a',
        memberName: 'jack',
      })
    ).resolves.toEqual({ ok: false, reason: 'provider_mismatch' });
  });

  it('resolves OpenCode turn-settled payloads from durable team/member identity', async () => {
    const resolver = new TeamRuntimeTurnSettledTargetResolver({
      teamSource: {
        listTeams: vi.fn(async () => {
          throw new Error('opencode path should not scan attributed files');
        }),
        getConfig: vi.fn(async () => ({
          name: 'team-a',
          members: [{ name: 'Jack', providerId: 'opencode' }],
        }) satisfies TeamConfig),
      },
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
      memberLogsFinder: {
        listAttributedMemberFiles: vi.fn(async () => []),
      },
    });

    await expect(
      resolver.resolve({
        schemaVersion: 1,
        provider: 'opencode',
        hookEventName: 'Stop',
        sourceId: 'source-1',
        payloadHash: 'hash',
        recordedAt: '2026-04-29T12:00:00.000Z',
        sessionId: 'ses-1',
        teamName: 'team-a',
        memberName: 'jack',
      })
    ).resolves.toEqual({ ok: true, teamName: 'team-a', memberName: 'jack' });
  });

  it('rejects OpenCode events for non-OpenCode teammates', async () => {
    const resolver = new TeamRuntimeTurnSettledTargetResolver({
      teamSource: {
        listTeams: vi.fn(async () => []),
        getConfig: vi.fn(async () => ({
          name: 'team-a',
          members: [{ name: 'Jack', providerId: 'codex' }],
        }) satisfies TeamConfig),
      },
      membersMetaStore: { getMembers: vi.fn(async () => []) } as never,
    });

    await expect(
      resolver.resolve({
        schemaVersion: 1,
        provider: 'opencode',
        hookEventName: 'Stop',
        sourceId: 'source-1',
        payloadHash: 'hash',
        recordedAt: '2026-04-29T12:00:00.000Z',
        sessionId: 'ses-1',
        teamName: 'team-a',
        memberName: 'jack',
      })
    ).resolves.toEqual({ ok: false, reason: 'provider_mismatch' });
  });
});
