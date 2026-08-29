import { buildCanonicalRosterAuthorizationRaw } from '@main/services/team/buildCanonicalRosterAuthorizationRaw';
import { describe, expect, it } from 'vitest';

import type { TeamMember } from '@shared/types';

describe('buildCanonicalRosterAuthorizationRaw', () => {
  it.each(['lead', 'orchestrator'] as const)(
    'upgrades legacy rosters with a nonstandard %s lead name',
    (agentType) => {
      const lead: TeamMember = { name: 'captain', agentType };
      const member: TeamMember = { name: 'alice', role: 'Reviewer', agentType: 'general-purpose' };
      const raw = `{"version":1,"cwd":"/exact/cwd","providerBackendId":"backend","opaque":{"x":1},"members":[{"name":"captain","agentType":"${agentType}"},{"name":"alice","role":"Reviewer","agentType":"general-purpose","runtime":{"keep":true}}]}\n`;
      const result = JSON.parse(
        buildCanonicalRosterAuthorizationRaw({
          priorRaw: raw,
          existing: [lead, member],
          requested: [{ name: 'alice', role: 'Reviewer' }],
          replacement: [lead, member],
          serializeFallback: () => 'fallback',
          normalizeRootBackend: () => undefined,
        })
      ) as { version: number; members: TeamMember[] };
      expect(result.version).toBe(2);
      expect(result.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'captain', agentType }),
          expect.objectContaining({ name: 'alice', role: 'Reviewer' }),
        ])
      );
    }
  );

  it('preserves top-level and member metadata while applying an edited roster', () => {
    const raw = JSON.stringify({
      version: 1,
      cwd: '/exact/cwd',
      opaque: { x: 1 },
      members: [
        { name: 'captain', agentType: 'lead', leadOpaque: true },
        { name: 'alice', role: 'Old', memberOpaque: true },
      ],
    });
    const result = JSON.parse(
      buildCanonicalRosterAuthorizationRaw({
        priorRaw: raw,
        existing: [
          { name: 'captain', agentType: 'lead' },
          { name: 'alice', role: 'Old' },
        ],
        requested: [{ name: 'alice', role: 'New' }],
        replacement: [
          { name: 'captain', agentType: 'lead' },
          { name: 'alice', role: 'New' },
        ],
        serializeFallback: () => 'fallback',
        normalizeRootBackend: () => undefined,
      })
    ) as Record<string, unknown> & { members: Record<string, unknown>[] };
    expect(result).toMatchObject({
      cwd: '/exact/cwd',
      opaque: { x: 1 },
    });
    expect(result.members).toEqual([
      expect.objectContaining({ name: 'captain', leadOpaque: true }),
      expect.objectContaining({ name: 'alice', role: 'New', memberOpaque: true }),
    ]);
  });

  it.each([
    ['null entry', [{ name: 'alice', role: 'Reviewer' }, null]],
    ['junk entry', [{ name: 'alice', role: 'Reviewer' }, 'junk']],
    [
      'duplicate name',
      [
        { name: 'alice', role: 'Reviewer' },
        { name: 'ALICE', role: 'Unauthorized duplicate' },
      ],
    ],
  ])('rejects an unchanged v2 roster containing a %s', (_label, rawMembers) => {
    expect(() =>
      buildCanonicalRosterAuthorizationRaw({
        priorRaw: JSON.stringify({ version: 2, members: rawMembers }),
        existing: [{ name: 'alice', role: 'Reviewer' }],
        requested: [{ name: 'alice', role: 'Reviewer' }],
        replacement: [{ name: 'alice', role: 'Reviewer' }],
        serializeFallback: () => 'fallback',
        normalizeRootBackend: () => undefined,
      })
    ).toThrow('Invalid current members.meta.json roster');
  });

  it.each([
    ['removedAt', 'yes'],
    ['joinedAt', 'yesterday'],
    ['providerId', 42],
    ['providerBackendId', false],
    ['effort', 'extreme'],
    ['fastMode', true],
    ['isolation', 'shared'],
    ['mcpPolicy', { mode: 'strictAllowlist', serverNames: [7] }],
  ])('rejects a type-corrupt v2 %s field', (field, value) => {
    expect(() =>
      buildCanonicalRosterAuthorizationRaw({
        priorRaw: JSON.stringify({
          version: 2,
          members: [{ name: 'alice', role: 'Reviewer', [field]: value }],
        }),
        existing: [{ name: 'alice', role: 'Reviewer' }],
        requested: [{ name: 'alice', role: 'Reviewer' }],
        replacement: [{ name: 'alice', role: 'Reviewer' }],
        serializeFallback: () => 'fallback',
        normalizeRootBackend: () => undefined,
      })
    ).toThrow('Invalid current members.meta.json roster');
  });

  it('rejects a v2 raw projection that differs from the decoded projection', () => {
    expect(() =>
      buildCanonicalRosterAuthorizationRaw({
        priorRaw: JSON.stringify({
          version: 2,
          members: [{ name: 'alice', role: 'Reviewer', removedAt: 123 }],
        }),
        existing: [{ name: 'alice', role: 'Reviewer' }],
        requested: [{ name: 'alice', role: 'Reviewer' }],
        replacement: [{ name: 'alice', role: 'Reviewer' }],
        serializeFallback: () => 'fallback',
        normalizeRootBackend: () => undefined,
      })
    ).toThrow('differs from its decoded projection');
  });
});
