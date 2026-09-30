import { createHash } from 'node:crypto';

import {
  AdoptTeamRoster,
  createTeamRosterAdoptionFingerprint,
  type LegacyTeamRosterEvidence,
  parseTeamRoster,
  parseTeamRosterAdoptionFingerprint,
  reconcileLegacyTeamRosterEvidence,
  TEAM_ROSTER_SCHEMA_VERSION,
  type TeamRoster,
  TeamRosterIdentityAmbiguityError,
  type TeamRosterRepository,
} from '@features/team-lifecycle';
import {
  type MemberId,
  parseLegacyMemberKey,
  parseMemberId,
  parseTeamId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const memberIds = [
  parseMemberId(`member_${'1'.repeat(32)}`),
  parseMemberId(`member_${'2'.repeat(32)}`),
  parseMemberId(`member_${'3'.repeat(32)}`),
];
const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

function evidence(members: LegacyTeamRosterEvidence['members']): LegacyTeamRosterEvidence {
  return { teamId, members };
}

function row(
  source: 'config' | 'members_meta',
  legacyMemberKey: string,
  overrides: Partial<LegacyTeamRosterEvidence['members'][number]> = {}
): LegacyTeamRosterEvidence['members'][number] {
  return {
    source,
    sourceOrdinal: 0,
    legacyMemberKey,
    state: 'active',
    providerId: null,
    model: null,
    role: null,
    workflow: null,
    isolation: null,
    ...overrides,
  };
}

describe('TeamRoster legacy adoption', () => {
  it('reconciles exact config/meta evidence without dropping identity and orders deterministically', () => {
    const result = reconcileLegacyTeamRosterEvidence({
      sha256Hex,
      evidence: evidence([
        row('members_meta', 'builder', {
          role: 'implementation',
          providerId: 'codex',
        }),
        row('config', 'reviewer', { providerId: 'anthropic' }),
        row('config', 'builder', { providerId: 'codex' }),
      ]),
    });

    expect(result.members).toEqual([
      {
        legacyMemberKey: 'builder',
        state: 'active',
        providerId: 'codex',
        model: null,
        role: 'implementation',
        workflow: null,
        isolation: null,
      },
      {
        legacyMemberKey: 'reviewer',
        state: 'active',
        providerId: 'anthropic',
        model: null,
        role: null,
        workflow: null,
        isolation: null,
      },
    ]);
    expect(result.adoptionFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(result.members)).toBe(true);
  });

  it.each([
    {
      label: 'case collision',
      rows: [row('config', 'Builder'), row('members_meta', 'builder')],
      detail: 'case_fold_collision',
    },
    {
      label: 'CLI auto suffix collision',
      rows: [row('members_meta', 'builder'), row('config', 'builder-2')],
      detail: 'cli_auto_suffix_collision',
    },
    {
      label: 'active/removed disagreement',
      rows: [row('config', 'builder'), row('members_meta', 'builder', { state: 'removed' })],
      detail: 'active_removed_conflict',
    },
    {
      label: 'provider disagreement',
      rows: [
        row('config', 'builder', { providerId: 'codex' }),
        row('members_meta', 'builder', { providerId: 'opencode' }),
      ],
      detail: 'provider_conflict',
    },
    {
      label: 'same-source duplicate',
      rows: [
        row('members_meta', 'builder', { sourceOrdinal: 0 }),
        row('members_meta', 'builder', { sourceOrdinal: 1 }),
      ],
      detail: 'duplicate_key_within_source',
    },
  ])('fails closed for $label', ({ rows, detail }) => {
    try {
      reconcileLegacyTeamRosterEvidence({
        sha256Hex,
        evidence: evidence(rows),
      });
      expect.fail('expected roster identity adoption to fail closed');
    } catch (error) {
      expect(error).toBeInstanceOf(TeamRosterIdentityAmbiguityError);
      expect(error).toMatchObject({
        code: 'roster_identity_ambiguous',
        detail,
      });
    }
  });

  it('keeps a numeric-suffix key when no base key exists', () => {
    const result = reconcileLegacyTeamRosterEvidence({
      sha256Hex,
      evidence: evidence([row('members_meta', 'builder-2', { providerId: 'codex' })]),
    });
    expect(result.members.map(({ legacyMemberKey }) => legacyMemberKey)).toEqual(['builder-2']);
  });

  it('requires provider evidence but accepts it from either exact source without defaulting', () => {
    try {
      reconcileLegacyTeamRosterEvidence({
        sha256Hex,
        evidence: evidence([row('config', 'builder')]),
      });
      expect.fail('expected missing provider evidence to fail closed');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'roster_identity_ambiguous',
        detail: 'provider_missing',
      });
    }

    const result = reconcileLegacyTeamRosterEvidence({
      sha256Hex,
      evidence: evidence([
        row('config', 'builder'),
        row('members_meta', 'builder', { providerId: 'codex' }),
      ]),
    });
    expect(result.members[0]?.providerId).toBe('codex');
  });

  it('uses deterministic canonical SHA-256 adoption fingerprints', () => {
    const members = [
      {
        legacyMemberKey: parseLegacyMemberKey('builder'),
        state: 'active' as const,
        providerId: 'codex' as const,
        model: null,
        role: 'implementation',
        workflow: null,
        isolation: null,
      },
    ];
    const canonical = JSON.stringify({
      members: [
        {
          isolation: null,
          legacyMemberKey: 'builder',
          model: null,
          providerId: 'codex',
          role: 'implementation',
          state: 'active',
          workflow: null,
        },
      ],
      teamId,
    });

    const expected = 'sha256:39abc464da63295e80a5a3b868e4f569fc5a6238a245ff568f35b1525b221aac';
    expect(`sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`).toBe(expected);
    expect(createTeamRosterAdoptionFingerprint({ teamId, members }, sha256Hex)).toBe(expected);
  });

  it('adopts once and returns the persisted MemberIds on deterministic reload', async () => {
    let stored: TeamRoster | null = null;
    const repository: TeamRosterRepository = {
      getTeamRoster: vi.fn(async () => stored),
      adoptTeamRosterIfAbsent: vi.fn(async (roster) => {
        if (stored) return { status: 'existing' as const, roster: stored };
        stored = roster;
        return { status: 'created' as const, roster };
      }),
    };
    let idIndex = 0;
    const useCase = new AdoptTeamRoster({
      evidenceSource: {
        readLegacyTeamRosterEvidence: vi.fn(async () => ({
          status: 'available' as const,
          evidence: evidence([
            row('members_meta', 'builder', { providerId: 'codex' }),
            row('members_meta', 'reviewer', { providerId: 'anthropic' }),
          ]),
        })),
      },
      repository,
      memberIdFactory: {
        createMemberId: () => memberIds[idIndex++] as MemberId,
      },
      clock: { now: () => new Date('2026-07-23T10:00:00.000Z') },
      fingerprintHasher: { sha256Hex },
    });

    const first = await useCase.execute({ teamId });
    const second = await useCase.execute({ teamId });

    expect(first).toMatchObject({ status: 'adopted' });
    expect(second).toMatchObject({ status: 'already_adopted' });
    if (first.status === 'blocked' || second.status === 'blocked') throw new Error('unexpected');
    expect(second.roster).toEqual(first.roster);
    expect(second.roster.rosterGeneration).toBe(1);
    expect(second.roster.members.map(({ memberRevision }) => memberRevision)).toEqual([1, 1]);
    expect(idIndex).toBe(2);
    expect(repository.adoptTeamRosterIfAbsent).toHaveBeenCalledTimes(1);
  });

  it('blocks when current legacy evidence no longer matches the persisted roster', async () => {
    const stored = parseTeamRoster({
      schemaVersion: TEAM_ROSTER_SCHEMA_VERSION,
      teamId,
      rosterGeneration: 1,
      adoptionFingerprint: parseTeamRosterAdoptionFingerprint(`sha256:${'f'.repeat(64)}`),
      adoptedAt: '2026-07-23T10:00:00.000Z',
      members: [],
    });
    const useCase = new AdoptTeamRoster({
      evidenceSource: {
        readLegacyTeamRosterEvidence: async () => ({
          status: 'available',
          evidence: evidence([row('config', 'builder', { providerId: 'anthropic' })]),
        }),
      },
      repository: {
        getTeamRoster: async () => stored,
        adoptTeamRosterIfAbsent: async () => {
          throw new Error('must not write');
        },
      },
      memberIdFactory: { createMemberId: () => memberIds[0] },
      clock: { now: () => new Date('2026-07-23T10:00:00.000Z') },
      fingerprintHasher: { sha256Hex },
    });

    await expect(useCase.execute({ teamId })).resolves.toEqual({
      status: 'blocked',
      reason: 'persisted_roster_conflict',
    });
  });
});
