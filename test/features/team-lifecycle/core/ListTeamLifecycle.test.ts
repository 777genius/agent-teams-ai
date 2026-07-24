import { describe, expect, it } from 'vitest';

import {
  ListTeamLifecycle,
  type ListTeamLifecycleRequest,
  type ListTeamLifecycleResult,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadSource,
} from '../../../../src/features/team-lifecycle';
import { createQueryContext, type QueryContext } from '../../../../src/shared/contracts/hosted';
import manifest from '../../../fixtures/hosted-web/phase-1/team-lifecycle/manifest.json';
import corrupt from '../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/corrupt.json';
import draft from '../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/draft.json';
import empty from '../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/empty.json';
import notFound from '../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/not-found-inapplicable.json';
import partial from '../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/partial.json';
import provisioning from '../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/provisioning-inapplicable.json';
import stale from '../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/stale.json';
import success from '../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/success.json';
import unavailable from '../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unavailable.json';
import unexpected from '../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unexpected.json';

const SEMANTIC_OUTCOME_DRIFT_DIAGNOSTIC = 'phase1-semantic-outcome-drift';

interface FixtureSuccessOracle {
  readonly kind: 'success';
  readonly page: {
    readonly schemaVersion: 1;
    readonly snapshotRevision: string;
    readonly items: readonly {
      readonly teamId: string;
      readonly displayName: string;
      readonly lifecycle: string;
      readonly revision: string;
    }[];
    readonly nextCursor: string | null;
  };
  readonly warnings: readonly [];
}

interface FixtureFailureOracle {
  readonly kind: 'failure';
  readonly code: string;
  readonly reason: string;
  readonly retryable: boolean;
  readonly diagnosticPresent: boolean;
  readonly retryAfterMs?: number;
}

interface FixtureRejectedOracle {
  readonly kind: 'rejected';
  readonly code: string;
  readonly reason: string;
}

type FixtureOracle = FixtureSuccessOracle | FixtureFailureOracle | FixtureRejectedOracle;

interface OutcomeFixture {
  readonly vectorId: string;
  readonly auditedState: string;
  readonly oracles: readonly FixtureOracle[];
}

const outcomeFixtures = [
  success,
  empty,
  notFound,
  draft,
  provisioning,
  corrupt,
  partial,
  unavailable,
  stale,
  unexpected,
] as unknown as readonly OutcomeFixture[];

class InMemoryTeamLifecycleSource implements TeamLifecycleReadSource {
  readonly requests: ListTeamLifecycleRequest[] = [];
  readonly contexts: QueryContext[] = [];

  constructor(private readonly value: unknown) {}

  listTeamLifecycle(
    request: ListTeamLifecycleRequest,
    context: QueryContext
  ): ListTeamLifecycleResult {
    this.requests.push(request);
    this.contexts.push(context);
    return this.value as ListTeamLifecycleResult;
  }
}

function requestValue(): unknown {
  return {
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    cursor: null,
    expectedRevision: null,
  };
}

function executionContext(): QueryContext {
  return createQueryContext({
    ...manifest.fakePrincipal,
    deadlineAtMs: manifest.fixedClockMs + 30_000,
    signal: new AbortController().signal,
  });
}

function sourceValue(oracle: FixtureOracle): unknown {
  if (oracle.kind === 'success') {
    return {
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      kind: 'success',
      snapshotRevision: oracle.page.snapshotRevision,
      items: oracle.page.items,
      nextCursor: oracle.page.nextCursor,
    };
  }
  if (oracle.kind === 'failure') {
    return {
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      kind: 'failure',
      error: {
        code: oracle.code,
        reason: oracle.reason,
        ...(oracle.diagnosticPresent
          ? { diagnosticId: `team-lifecycle-read.fixture-${oracle.reason}` }
          : {}),
        ...(oracle.retryAfterMs === undefined ? {} : { retryAfterMs: oracle.retryAfterMs }),
      },
      retryable: oracle.retryable,
    };
  }
  return {
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'inapplicable',
    code: oracle.code,
    reason: oracle.reason,
  };
}

function semanticProjection(result: ListTeamLifecycleResult): FixtureOracle {
  if (result.kind === 'success') {
    return {
      kind: 'success',
      page: {
        schemaVersion: result.schemaVersion,
        snapshotRevision: result.snapshotRevision,
        items: result.items,
        nextCursor: result.nextCursor,
      },
      warnings: [],
    };
  }
  if (result.kind === 'failure') {
    return {
      kind: 'failure',
      code: result.error.code,
      reason: result.error.reason,
      retryable: result.retryable,
      diagnosticPresent: result.error.diagnosticId !== undefined,
      ...(result.error.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: result.error.retryAfterMs }),
    };
  }
  return { kind: 'rejected', code: result.code, reason: result.reason };
}

function assertSemanticOutcome(expected: FixtureOracle, actual: FixtureOracle): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new TypeError(SEMANTIC_OUTCOME_DRIFT_DIAGNOSTIC);
  }
}

describe('ListTeamLifecycle', () => {
  it('matches all ten immutable fixture scenarios and invokes its source once per valid request', async () => {
    expect(outcomeFixtures.map((fixture) => fixture.vectorId)).toEqual(
      manifest.vectors.map((vector) => vector.vectorId)
    );

    for (const fixture of outcomeFixtures) {
      for (const oracle of fixture.oracles) {
        const source = new InMemoryTeamLifecycleSource(sourceValue(oracle));
        const result = await new ListTeamLifecycle(source).execute(
          requestValue(),
          executionContext()
        );

        expect(source.requests).toHaveLength(1);
        expect(source.requests[0].schemaVersion).toBe(TEAM_LIFECYCLE_READ_SCHEMA_VERSION);
        expect(source.requests[0].cursor).toBeNull();
        expect(source.requests[0].expectedRevision).toBeNull();
        expect(() => assertSemanticOutcome(oracle, semanticProjection(result))).not.toThrow();
      }
    }
  });

  it('returns the valid empty result without inventing an error', async () => {
    const source = new InMemoryTeamLifecycleSource(sourceValue(outcomeFixtures[1].oracles[0]));
    const result = await new ListTeamLifecycle(source).execute(requestValue(), executionContext());

    expect(result).toMatchObject({ kind: 'success', items: [], nextCursor: null });
    expect(source.requests).toHaveLength(1);
  });

  it('normalizes ordering and returns identical values for identical inputs', async () => {
    const oracle = outcomeFixtures[0].oracles[0] as FixtureSuccessOracle;
    const reversed = {
      ...(sourceValue(oracle) as Record<string, unknown>),
      items: [...oracle.page.items].reverse(),
    };
    const source = new InMemoryTeamLifecycleSource(reversed);
    const useCase = new ListTeamLifecycle(source);

    const first = await useCase.execute(requestValue(), executionContext());
    const second = await useCase.execute(requestValue(), executionContext());

    expect(second).toEqual(first);
    expect(first.kind).toBe('success');
    if (first.kind === 'success') {
      expect(first.items.map((item) => item.teamId)).toEqual([
        'team_alpha',
        'team_beta_a',
        'team_beta_b',
      ]);
    }
    expect(source.requests).toHaveLength(2);
  });

  it('returns a fresh narrow projection when the source adds same-version response fields', async () => {
    const oracle = outcomeFixtures[0].oracles[0] as FixtureSuccessOracle;
    const additiveSymbol = Symbol('source-additive');
    const itemSymbol = Symbol('item-additive');
    const sourceResult = {
      ...(sourceValue(oracle) as Record<PropertyKey, unknown>),
      additiveSourceField: true,
      [additiveSymbol]: true,
      items: oracle.page.items.map((item) => ({
        ...item,
        additiveItemField: true,
        [itemSymbol]: true,
      })),
    };
    const source = new InMemoryTeamLifecycleSource(sourceResult);

    const result = await new ListTeamLifecycle(source).execute(requestValue(), executionContext());

    expect(result).not.toBe(sourceResult);
    expect(source.requests).toHaveLength(1);
    expect(Reflect.ownKeys(result)).not.toContain('additiveSourceField');
    expect(Object.getOwnPropertySymbols(result)).toEqual([]);
    if (result.kind === 'success') {
      expect(result.items).not.toBe(sourceResult.items);
      for (const item of result.items) {
        expect(Reflect.ownKeys(item)).not.toContain('additiveItemField');
        expect(Object.getOwnPropertySymbols(item)).toEqual([]);
      }
    }
  });

  it('normalizes malformed requests and thrown values without leaking source text', async () => {
    const source = new InMemoryTeamLifecycleSource(sourceValue(outcomeFixtures[0].oracles[0]));
    const malformed = await new ListTeamLifecycle(source).execute(
      { schemaVersion: 1 },
      executionContext()
    );

    expect(malformed).toMatchObject({
      kind: 'failure',
      error: { code: 'invalid_request', reason: 'request_invalid' },
    });
    expect(source.requests).toHaveLength(0);

    const throwingSource: TeamLifecycleReadSource = {
      listTeamLifecycle() {
        throw new Error('source detail must stay private');
      },
    };
    const normalized = await new ListTeamLifecycle(throwingSource).execute(
      requestValue(),
      executionContext()
    );
    expect(normalized).toMatchObject({
      kind: 'failure',
      error: { code: 'internal', reason: 'unexpected' },
    });
    expect(JSON.stringify(normalized)).not.toContain('source detail');
  });

  it('rejects a deliberate fixture semantic mismatch with the exact diagnostic', () => {
    const expected = outcomeFixtures[0].oracles[0];
    const mismatched = outcomeFixtures[5].oracles[0];

    expect(() => assertSemanticOutcome(expected, mismatched)).toThrow(
      SEMANTIC_OUTCOME_DRIFT_DIAGNOSTIC
    );
  });
});
