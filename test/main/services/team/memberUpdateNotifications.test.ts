import {
  buildReplaceMembersDiff,
  buildReplaceMembersSummaryMessage,
} from '@main/services/team/memberUpdateNotifications';
import { describe, expect, it } from 'vitest';

describe('member update notifications', () => {
  it('reports MCP policy changes as restart-required live roster updates', () => {
    const diff = buildReplaceMembersDiff(
      [
        {
          name: 'alice',
          role: 'Developer',
          providerId: 'codex',
        },
      ],
      [
        {
          name: 'alice',
          role: 'Developer',
          providerId: 'codex',
          mcpPolicy: { mode: 'appOnly' },
        },
      ]
    );

    expect(diff.updated).toEqual([
      {
        name: 'alice',
        changes: ['MCP access policy changed - restart required'],
      },
    ]);
    expect(buildReplaceMembersSummaryMessage(diff)).toContain(
      'MCP access policy changed - restart required'
    );
  });

  it('reports provider backend and fast mode changes as restart-required updates', () => {
    const diff = buildReplaceMembersDiff(
      [
        {
          name: 'alice',
          role: 'Developer',
          providerId: 'gemini',
          providerBackendId: 'api',
          fastMode: 'off',
        },
      ],
      [
        {
          name: 'alice',
          role: 'Developer',
          providerId: 'gemini',
          providerBackendId: 'cli-sdk',
          fastMode: 'on',
        },
      ]
    );

    expect(diff.updated).toEqual([
      {
        name: 'alice',
        changes: [
          'provider backend changed - restart required',
          'fast mode changed - restart required',
        ],
      },
    ]);
  });

  it('uses the shared lead policy when excluding roster owners from the diff', () => {
    const diff = buildReplaceMembersDiff(
      [
        { name: 'lead', role: 'Coordinator', providerId: 'codex' },
        {
          name: 'captain',
          agentType: 'orchestrator',
          role: 'Coordinator',
          providerId: 'codex',
        },
        { name: 'captain-role', role: 'team-lead', providerId: 'codex' },
      ],
      []
    );

    expect(diff).toEqual({ added: [], removed: [], updated: [] });
  });

  it('keeps ordinary teammates with lead-specialist roles in the diff', () => {
    const diff = buildReplaceMembersDiff(
      [
        { name: 'alice', role: 'Tech Lead', providerId: 'codex' },
        { name: 'bob', role: 'Lead builder', providerId: 'codex' },
      ],
      []
    );

    expect(diff.removed).toEqual(['alice', 'bob']);
  });

  it('normalizes semantically equivalent MCP policies before comparing members', () => {
    const diff = buildReplaceMembersDiff(
      [{ name: 'alice', providerId: 'codex', mcpPolicy: { mode: 'inheritLead' } }],
      [{ name: 'alice', providerId: 'codex' }]
    );

    expect(diff.updated).toEqual([]);
  });

  it('normalizes unknown legacy provider ids before comparing persisted members', () => {
    const diff = buildReplaceMembersDiff(
      [
        {
          name: 'alice',
          providerId: 'legacy-provider' as never,
          providerBackendId: 'codex-native',
        },
      ],
      [{ name: 'alice' }]
    );

    expect(diff).toEqual({ added: [], removed: [], updated: [] });
  });
});
