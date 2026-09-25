import {
  type CanonicalListTeamLifecycleResult,
  type CanonicalTeamLifecycleListItem,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleState,
} from '@features/team-lifecycle/contracts';
import {
  TEAM_LIFECYCLE_PROJECTION_SHADOW_MAX_BINDINGS,
  TEAM_LIFECYCLE_PROJECTION_SHADOW_MAX_FINDINGS,
  TEAM_LIFECYCLE_PROJECTION_SHADOW_MAX_LEGACY_ITEMS,
  TeamLifecycleProjectionShadowComparator,
} from '@features/team-lifecycle/main/infrastructure/TeamLifecycleProjectionShadowComparator';
import {
  parseCursor,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
  type Revision,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

import type {
  LegacyTeamBindingPage,
  LegacyTeamIdentityBinding,
  LegacyTeamReadAvailability,
} from '@features/team-lifecycle/main/infrastructure/LegacyTeamLifecycleReadSource';

const WORKSPACE_A = parseWorkspaceId(`workspace_${'a'.repeat(32)}`);
const WORKSPACE_B = parseWorkspaceId(`workspace_${'b'.repeat(32)}`);
const REVISION_A = parseRevision('revision_a');
const REVISION_B = parseRevision('revision_b');
const SNAPSHOT_A = parseRevision('revision_snapshot_a');
const SNAPSHOT_B = parseRevision('revision_snapshot_b');
const TEAM_A = parseTeamId(`team_${'a'.repeat(32)}`);
const TEAM_B = parseTeamId(`team_${'b'.repeat(32)}`);

const comparator = new TeamLifecycleProjectionShadowComparator();

function indexedTeamId(index: number): TeamId {
  return parseTeamId(`team_${index.toString(16).padStart(32, '0')}`);
}

function binding(
  options: {
    readonly workspaceId?: WorkspaceId;
    readonly teamId?: TeamId;
    readonly legacyTeamName?: string;
    readonly displayName?: string;
    readonly revision?: Revision;
    readonly availability?: LegacyTeamReadAvailability;
  } = {}
): LegacyTeamIdentityBinding {
  return Object.freeze({
    workspaceId: options.workspaceId ?? WORKSPACE_A,
    teamId: options.teamId ?? TEAM_A,
    legacyTeamName: options.legacyTeamName ?? 'legacy-alpha',
    displayName: options.displayName ?? 'Alpha',
    revision: options.revision ?? REVISION_A,
    ...(options.availability === undefined ? {} : { availability: options.availability }),
  });
}

function page(
  bindings: readonly LegacyTeamIdentityBinding[],
  snapshotRevision: Revision = SNAPSHOT_A
): LegacyTeamBindingPage {
  return Object.freeze({
    snapshotRevision,
    bindings: Object.freeze([...bindings]),
    nextCursor: null,
  });
}

function item(
  options: {
    readonly workspaceId?: WorkspaceId;
    readonly teamId?: TeamId;
    readonly displayName?: string;
    readonly lifecycle?: TeamLifecycleState;
    readonly revision?: Revision;
  } = {}
): CanonicalTeamLifecycleListItem {
  return Object.freeze({
    workspaceId: options.workspaceId ?? WORKSPACE_A,
    teamId: options.teamId ?? TEAM_A,
    displayName: options.displayName ?? 'Alpha',
    lifecycle: options.lifecycle ?? 'ready',
    revision: options.revision ?? REVISION_A,
  });
}

function success(
  items: readonly CanonicalTeamLifecycleListItem[],
  snapshotRevision: Revision = SNAPSHOT_A
): CanonicalListTeamLifecycleResult {
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'success',
    snapshotRevision,
    items: Object.freeze([...items]),
    nextCursor: null,
  });
}

describe('TeamLifecycleProjectionShadowComparator', () => {
  it('matches current, draft, degraded, and deleted projections from one captured observation', () => {
    const bindings = [
      binding(),
      binding({
        teamId: TEAM_B,
        legacyTeamName: 'legacy-beta',
        displayName: 'Beta',
        revision: REVISION_B,
        availability: 'draft',
      }),
      binding({
        teamId: indexedTeamId(3),
        legacyTeamName: 'legacy-gamma',
        displayName: 'Gamma',
      }),
      binding({
        teamId: indexedTeamId(4),
        legacyTeamName: 'legacy-delta',
        displayName: 'Delta',
      }),
    ];
    const canonical = success([
      item(),
      item({
        teamId: TEAM_B,
        displayName: 'Beta',
        lifecycle: 'draft',
        revision: REVISION_B,
      }),
      item({ teamId: indexedTeamId(3), displayName: 'Gamma', lifecycle: 'degraded' }),
      item({ teamId: indexedTeamId(4), displayName: 'Delta', lifecycle: 'deleted' }),
    ]);
    const legacyObservation = Object.freeze([
      Object.freeze({ teamName: 'legacy-delta', deletedAt: '2026-07-26T00:00:00.000Z' }),
      Object.freeze({ teamName: 'legacy-alpha' }),
      Object.freeze({ teamName: 'legacy-gamma', partialLaunchFailure: true }),
    ]);

    expect(comparator.compare(canonical, page(bindings), legacyObservation)).toEqual({
      status: 'match',
      snapshotRevision: SNAPSHOT_A,
      comparedCount: 4,
      findings: [],
    });
  });

  it('reports every shared-field and snapshot revision mismatch without returning raw values', () => {
    const report = comparator.compare(
      success(
        [
          item({
            workspaceId: WORKSPACE_B,
            displayName: 'Canonical Private Label',
            lifecycle: 'stopped',
            revision: REVISION_B,
          }),
        ],
        SNAPSHOT_B
      ),
      page([binding({ displayName: 'Legacy Private Label' })]),
      [{ teamName: 'legacy-alpha' }]
    );

    expect(report).toEqual({
      status: 'mismatch',
      snapshotRevision: SNAPSHOT_B,
      comparedCount: 1,
      findings: [
        { code: 'snapshot_revision_mismatch' },
        { code: 'display_name_mismatch', teamId: TEAM_A },
        { code: 'lifecycle_mismatch', teamId: TEAM_A },
        { code: 'revision_mismatch', teamId: TEAM_A },
        { code: 'workspace_id_mismatch', teamId: TEAM_A },
      ],
    });
    expect(JSON.stringify(report)).not.toMatch(/Canonical Private Label|Legacy Private Label/);
  });

  it('uses canonical TeamId presence to report missing items on either side', () => {
    const report = comparator.compare(
      success([item({ teamId: TEAM_B, displayName: 'Beta', revision: REVISION_B })]),
      page([binding()]),
      [{ teamName: 'legacy-alpha' }]
    );

    expect(report).toEqual({
      status: 'mismatch',
      snapshotRevision: SNAPSHOT_A,
      comparedCount: 0,
      findings: [
        { code: 'canonical_item_missing', teamId: TEAM_A },
        { code: 'identity_binding_missing', teamId: TEAM_B },
      ],
    });
  });

  it.each([
    ['corrupt', 'legacy_evidence_corrupt'],
    ['partial', 'legacy_evidence_partial'],
    ['provisioning', 'legacy_evidence_provisioning'],
    ['unavailable', 'legacy_evidence_unavailable'],
  ] as const)('classifies %s identity evidence as not comparable', (availability, expectedCode) => {
    const report = comparator.compare(success([item()]), page([binding({ availability })]), [
      { teamName: 'legacy-alpha' },
    ]);

    expect(report).toEqual({
      status: 'not_comparable',
      snapshotRevision: SNAPSHOT_A,
      comparedCount: 0,
      findings: [{ code: expectedCode, teamId: TEAM_A }],
    });
  });

  it('reports a missing current legacy summary distinctly but permits a missing draft summary', () => {
    expect(comparator.compare(success([item()]), page([binding()]), [])).toEqual({
      status: 'not_comparable',
      snapshotRevision: SNAPSHOT_A,
      comparedCount: 0,
      findings: [{ code: 'legacy_summary_missing', teamId: TEAM_A }],
    });

    expect(
      comparator.compare(
        success([item({ lifecycle: 'draft' })]),
        page([binding({ availability: 'draft' })]),
        []
      )
    ).toEqual({
      status: 'match',
      snapshotRevision: SNAPSHOT_A,
      comparedCount: 1,
      findings: [],
    });
  });

  it('reports duplicate binding TeamIds and legacy names with distinct stable codes', () => {
    expect(
      comparator.compare(
        success([item()]),
        page([binding(), binding({ legacyTeamName: 'legacy-beta' })]),
        [{ teamName: 'legacy-alpha' }]
      )
    ).toEqual({
      status: 'not_comparable',
      snapshotRevision: SNAPSHOT_A,
      comparedCount: 0,
      findings: [{ code: 'identity_binding_team_id_duplicate', teamId: TEAM_A }],
    });

    expect(
      comparator.compare(
        success([item()]),
        page([
          binding(),
          binding({ teamId: TEAM_B, legacyTeamName: 'legacy-alpha', displayName: 'Beta' }),
        ]),
        [{ teamName: 'legacy-alpha' }]
      )
    ).toEqual({
      status: 'not_comparable',
      snapshotRevision: SNAPSHOT_A,
      comparedCount: 0,
      findings: [{ code: 'identity_binding_legacy_name_duplicate', teamId: TEAM_B }],
    });
  });

  it('rejects duplicate canonical and correlated legacy items', () => {
    const duplicateCanonical = success([item(), item()]) as CanonicalListTeamLifecycleResult;
    expect(comparator.compare(duplicateCanonical, page([binding()]), [])).toEqual({
      status: 'not_comparable',
      snapshotRevision: null,
      comparedCount: 0,
      findings: [{ code: 'canonical_result_invalid' }],
    });

    expect(
      comparator.compare(success([item()]), page([binding()]), [
        { teamName: 'legacy-alpha' },
        { teamName: 'legacy-alpha' },
      ])
    ).toEqual({
      status: 'not_comparable',
      snapshotRevision: SNAPSHOT_A,
      comparedCount: 0,
      findings: [{ code: 'legacy_observation_duplicate', teamId: TEAM_A }],
    });
  });

  it('handles sparse, malformed, unavailable, and oversized observations without throwing', () => {
    const sparse: unknown[] = new Array(2);
    sparse[1] = { teamName: 'legacy-alpha' };
    const oversized = Array.from(
      { length: TEAM_LIFECYCLE_PROJECTION_SHADOW_MAX_LEGACY_ITEMS + 1 },
      (_, index) => ({ teamName: `foreign-${index}` })
    );
    const inputs = [
      [sparse, 'legacy_observation_invalid'],
      [[null], 'legacy_observation_invalid'],
      [[{ teamName: '/private/team' }], 'legacy_observation_invalid'],
      [[{ teamName: 'con' }], 'legacy_observation_invalid'],
      [[{ teamName: 'legacy-alpha', pendingCreate: 'yes' }], 'legacy_observation_invalid'],
      [[{ teamName: 'legacy-alpha', deletedAt: null }], 'legacy_observation_invalid'],
      [null, 'legacy_evidence_unavailable'],
      [oversized, 'legacy_observation_oversized'],
    ] as const;

    for (const [legacyObservation, code] of inputs) {
      expect(() =>
        comparator.compare(success([item()]), page([binding()]), legacyObservation)
      ).not.toThrow();
      expect(
        comparator.compare(success([item()]), page([binding()]), legacyObservation)
      ).toMatchObject({
        status: 'not_comparable',
        comparedCount: 0,
        findings: [{ code }],
      });
    }
  });

  it('classifies canonical failures, inapplicable results, and malformed pages as not comparable', () => {
    const failure = Object.freeze({
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      kind: 'failure',
      error: Object.freeze({ code: 'unavailable', reason: 'source_unavailable' }),
      retryable: true,
    }) satisfies CanonicalListTeamLifecycleResult;
    const inapplicable = Object.freeze({
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      kind: 'inapplicable',
      code: 'unsupported',
      reason: 'unknown_lifecycle_provisioning',
    }) satisfies CanonicalListTeamLifecycleResult;

    expect(comparator.compare(failure, page([binding()]), [])).toEqual({
      status: 'not_comparable',
      snapshotRevision: null,
      comparedCount: 0,
      findings: [{ code: 'canonical_result_failure' }],
    });
    expect(comparator.compare(inapplicable, page([binding()]), [])).toEqual({
      status: 'not_comparable',
      snapshotRevision: null,
      comparedCount: 0,
      findings: [{ code: 'canonical_result_inapplicable' }],
    });

    const malformedPage = {
      snapshotRevision: 'not-a-revision',
      bindings: [binding()],
      nextCursor: null,
    } as unknown as LegacyTeamBindingPage;
    expect(comparator.compare(success([item()]), malformedPage, [])).toEqual({
      status: 'not_comparable',
      snapshotRevision: SNAPSHOT_A,
      comparedCount: 0,
      findings: [{ code: 'identity_binding_page_invalid' }],
    });
  });

  it('is deterministic, deeply immutable, sorted by TeamId then code, and leaves inputs unchanged', () => {
    const canonical = success(
      [
        item({
          teamId: TEAM_B,
          displayName: 'Wrong Beta',
          lifecycle: 'deleted',
          revision: REVISION_A,
        }),
        item({ displayName: 'Wrong Alpha', lifecycle: 'stopped' }),
      ],
      SNAPSHOT_B
    );
    const identityPage = Object.freeze({
      snapshotRevision: SNAPSHOT_A,
      bindings: Object.freeze([
        binding({
          teamId: TEAM_B,
          legacyTeamName: 'legacy-beta',
          displayName: 'Beta',
          revision: REVISION_B,
        }),
        binding(),
      ]),
      nextCursor: parseCursor('cursor_next'),
    });
    const legacyObservation = Object.freeze([
      Object.freeze({ teamName: 'legacy-beta' }),
      Object.freeze({ teamName: 'legacy-alpha' }),
    ]);
    const before = JSON.stringify({ canonical, identityPage, legacyObservation });

    const first = comparator.compare(canonical, identityPage, legacyObservation);
    const second = comparator.compare(canonical, identityPage, legacyObservation);

    expect(first).toEqual(second);
    expect(first.findings).toEqual([
      { code: 'snapshot_revision_mismatch' },
      { code: 'display_name_mismatch', teamId: TEAM_A },
      { code: 'lifecycle_mismatch', teamId: TEAM_A },
      { code: 'display_name_mismatch', teamId: TEAM_B },
      { code: 'lifecycle_mismatch', teamId: TEAM_B },
      { code: 'revision_mismatch', teamId: TEAM_B },
    ]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.findings)).toBe(true);
    expect(first.findings.every(Object.isFrozen)).toBe(true);
    expect(JSON.stringify({ canonical, identityPage, legacyObservation })).toBe(before);
  });

  it('admits dense maximum inputs and keeps the densest possible report within its bound', () => {
    const bindings = Array.from(
      { length: TEAM_LIFECYCLE_PROJECTION_SHADOW_MAX_BINDINGS },
      (_, index) =>
        binding({
          teamId: indexedTeamId(index),
          legacyTeamName: `legacy-${index}`,
          displayName: `Team ${index}`,
          revision: REVISION_A,
        })
    );
    const canonicalItems = bindings.map((candidate, index) =>
      item({
        workspaceId: WORKSPACE_B,
        teamId: candidate.teamId,
        displayName: `Wrong ${index}`,
        lifecycle: 'stopped',
        revision: REVISION_B,
      })
    );
    const legacyObservation = bindings.map((candidate) => ({
      teamName: candidate.legacyTeamName,
    }));

    const report = comparator.compare(
      success(canonicalItems, SNAPSHOT_B),
      page(bindings),
      legacyObservation
    );

    expect(report.status).toBe('mismatch');
    expect(report.comparedCount).toBe(TEAM_LIFECYCLE_PROJECTION_SHADOW_MAX_BINDINGS);
    expect(report.findings).toHaveLength(TEAM_LIFECYCLE_PROJECTION_SHADOW_MAX_FINDINGS);
    expect(report.findings.every((_, index) => Object.hasOwn(report.findings, index))).toBe(true);
  });

  it('rejects sparse and oversized binding pages at the dense boundary', () => {
    const sparseBindings: LegacyTeamIdentityBinding[] = new Array(2);
    sparseBindings[1] = binding();
    const oversizedBindings = Array.from(
      { length: TEAM_LIFECYCLE_PROJECTION_SHADOW_MAX_BINDINGS + 1 },
      (_, index) =>
        binding({
          teamId: indexedTeamId(index),
          legacyTeamName: `legacy-${index}`,
          displayName: `Team ${index}`,
        })
    );

    for (const bindings of [sparseBindings, oversizedBindings]) {
      expect(comparator.compare(success([]), page(bindings), [])).toMatchObject({
        status: 'not_comparable',
        comparedCount: 0,
        findings: [{ code: 'identity_binding_page_invalid' }],
      });
    }
  });

  it('never leaks legacy names, paths, config, run IDs, or unrelated raw values', () => {
    const privateLegacyName = 'private-secret-team';
    const privateDisplayName = 'Secret Team Label';
    const canaries = [
      privateLegacyName,
      privateDisplayName,
      '/Users/person/private-project',
      'run_0123456789abcdef0123456789abcdef',
      'top-secret-config-value',
      'arbitrary-secret-value',
    ];
    const report = comparator.compare(
      success([item({ displayName: 'Canonical Label', lifecycle: 'degraded' })]),
      page([
        binding({
          legacyTeamName: privateLegacyName,
          displayName: privateDisplayName,
        }),
      ]),
      [
        {
          teamName: privateLegacyName,
          projectPath: canaries[2],
          config: { runId: canaries[3], secret: canaries[4] },
          arbitrary: canaries[5],
        },
      ]
    );
    const serialized = JSON.stringify(report);

    expect(report.status).toBe('mismatch');
    for (const canary of canaries) {
      expect(serialized).not.toContain(canary);
    }
    expect(Reflect.ownKeys(report)).toEqual([
      'status',
      'snapshotRevision',
      'comparedCount',
      'findings',
    ]);
    expect(report.findings.every((entry) => Reflect.ownKeys(entry).length <= 2)).toBe(true);
  });
});
