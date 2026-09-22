export const SEMANTIC_CORPUS_DIAGNOSTIC = 'phase1-semantic-outcome-mismatch' as const;
export const PATH_SECRET_DIAGNOSTIC = 'phase1-path-secret-leak' as const;

export const AUDITED_STATES = Object.freeze([
  'success',
  'empty',
  'not-found',
  'draft',
  'provisioning',
  'corrupt',
  'partial',
  'unavailable',
  'stale',
  'unexpected',
] as const);

export type AuditedState = (typeof AUDITED_STATES)[number];

interface SuccessOracle {
  readonly kind: 'success';
  readonly page: {
    readonly schemaVersion: 1;
    readonly snapshotRevision: string;
    readonly items: readonly {
      readonly teamId: string;
      readonly displayName: string;
      readonly lifecycle: 'draft' | 'ready' | 'running' | 'degraded' | 'stopped' | 'deleted';
      readonly revision: string;
    }[];
    readonly nextCursor: string | null;
  };
  readonly warnings: readonly [];
}

interface FailureOracle {
  readonly kind: 'failure';
  readonly code: 'invalid_request' | 'conflict' | 'unsupported' | 'unavailable' | 'internal';
  readonly reason: string;
  readonly retryable: boolean;
  readonly diagnosticPresent: boolean;
  readonly retryAfterMs?: number;
}

interface RejectedOracle {
  readonly kind: 'rejected';
  readonly code: 'not_applicable' | 'unsupported';
  readonly reason: string;
}

export type SemanticOracle = SuccessOracle | FailureOracle | RejectedOracle;

export interface SemanticOutcomeFixture {
  readonly schemaVersion: 1;
  readonly vectorId: string;
  readonly auditedState: AuditedState;
  readonly oracles: readonly SemanticOracle[];
}

export interface SemanticFixtureManifest {
  readonly schemaVersion: 1;
  readonly corpusId: string;
  readonly fixedClockMs: number;
  readonly fakePrincipal: {
    readonly actorId: string;
    readonly sessionId: string;
    readonly deploymentId: string;
    readonly bootId: string;
    readonly requestId: string;
    readonly authorizedScope: string;
  };
  readonly vectors: readonly {
    readonly vectorId: string;
    readonly auditedState: AuditedState;
    readonly applicability: 'applicable' | 'data' | 'inapplicable';
  }[];
}

export interface SemanticCorpusSummary {
  readonly corpusId: string;
  readonly vectorIds: readonly string[];
  readonly serializedOracle: string;
}

function semanticMismatch(): never {
  throw new TypeError(SEMANTIC_CORPUS_DIAGNOSTIC);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOpaque(value: string, prefix: string): void {
  if (!value.startsWith(`${prefix}_`) || value.length > 256) semanticMismatch();
}

function compareItems(
  left: SuccessOracle['page']['items'][number],
  right: SuccessOracle['page']['items'][number]
): number {
  const leftDisplay = left.displayName.normalize('NFKC').toLowerCase();
  const rightDisplay = right.displayName.normalize('NFKC').toLowerCase();
  if (leftDisplay !== rightDisplay) return leftDisplay < rightDisplay ? -1 : 1;
  if (left.teamId === right.teamId) return 0;
  return left.teamId < right.teamId ? -1 : 1;
}

function assertSuccess(oracle: SuccessOracle): void {
  if (oracle.warnings.length !== 0 || oracle.page.schemaVersion !== 1) semanticMismatch();
  assertOpaque(oracle.page.snapshotRevision, 'revision');
  if (oracle.page.nextCursor !== null) assertOpaque(oracle.page.nextCursor, 'cursor');

  for (const item of oracle.page.items) {
    assertOpaque(item.teamId, 'team');
    assertOpaque(item.revision, 'revision');
    if (
      !item.displayName ||
      Object.hasOwn(item, 'teamName') ||
      Object.hasOwn(item, 'projectPath')
    ) {
      semanticMismatch();
    }
  }

  const sorted = [...oracle.page.items].sort(compareItems);
  if (JSON.stringify(sorted) !== JSON.stringify(oracle.page.items)) semanticMismatch();
}

function assertFailure(oracle: FailureOracle): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(oracle.reason)) semanticMismatch();
  if (oracle.retryAfterMs !== undefined) {
    if (
      oracle.code !== 'unavailable' ||
      !Number.isSafeInteger(oracle.retryAfterMs) ||
      oracle.retryAfterMs < 1 ||
      oracle.retryAfterMs > 60_000
    ) {
      semanticMismatch();
    }
  }
}

function assertStateSemantics(fixture: SemanticOutcomeFixture): void {
  const success = fixture.oracles.filter(
    (oracle): oracle is SuccessOracle => oracle.kind === 'success'
  );
  const failure = fixture.oracles.filter(
    (oracle): oracle is FailureOracle => oracle.kind === 'failure'
  );
  const rejected = fixture.oracles.filter(
    (oracle): oracle is RejectedOracle => oracle.kind === 'rejected'
  );

  switch (fixture.auditedState) {
    case 'success':
      if (success.length !== 1 || success[0].page.items.length === 0) semanticMismatch();
      return;
    case 'empty':
      if (
        success.length !== 1 ||
        success[0].page.items.length !== 0 ||
        success[0].page.nextCursor !== null
      ) {
        semanticMismatch();
      }
      return;
    case 'draft':
      if (
        success.length !== 1 ||
        success[0].page.items.length !== 1 ||
        success[0].page.items[0].lifecycle !== 'draft'
      ) {
        semanticMismatch();
      }
      return;
    case 'not-found':
      if (
        rejected.length !== 1 ||
        rejected[0].code !== 'not_applicable' ||
        rejected[0].reason !== 'list_not_found_inapplicable'
      ) {
        semanticMismatch();
      }
      return;
    case 'provisioning':
      if (
        rejected.length !== 1 ||
        rejected[0].code !== 'unsupported' ||
        rejected[0].reason !== 'unknown_lifecycle_provisioning'
      ) {
        semanticMismatch();
      }
      return;
    case 'corrupt':
      if (
        failure.length !== 1 ||
        failure[0].code !== 'internal' ||
        failure[0].reason !== 'corrupt_source' ||
        failure[0].retryable ||
        !failure[0].diagnosticPresent
      ) {
        semanticMismatch();
      }
      return;
    case 'partial':
      if (
        failure.length !== 1 ||
        failure[0].code !== 'unavailable' ||
        failure[0].reason !== 'partial_source' ||
        !failure[0].retryable
      ) {
        semanticMismatch();
      }
      return;
    case 'unavailable':
      if (
        failure.length !== 1 ||
        failure[0].code !== 'unavailable' ||
        failure[0].reason !== 'source_unavailable' ||
        !failure[0].retryable ||
        failure[0].retryAfterMs === undefined
      ) {
        semanticMismatch();
      }
      return;
    case 'stale':
      if (
        failure.length !== 2 ||
        !failure.some(
          (oracle) => oracle.code === 'invalid_request' && oracle.reason === 'invalid_cursor'
        ) ||
        !failure.some(
          (oracle) => oracle.code === 'conflict' && oracle.reason === 'snapshot_changed'
        )
      ) {
        semanticMismatch();
      }
      return;
    case 'unexpected':
      if (
        failure.length !== 1 ||
        failure[0].code !== 'internal' ||
        failure[0].reason !== 'unexpected' ||
        failure[0].retryable ||
        !failure[0].diagnosticPresent
      ) {
        semanticMismatch();
      }
  }
}

function assertManifest(manifest: SemanticFixtureManifest): void {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.corpusId !== 'phase1-team-lifecycle-semantic-v1' ||
    manifest.fixedClockMs !== 1_704_067_200_000 ||
    manifest.vectors.length !== AUDITED_STATES.length
  ) {
    semanticMismatch();
  }

  const states = manifest.vectors.map((vector) => vector.auditedState);
  if (
    new Set(states).size !== AUDITED_STATES.length ||
    AUDITED_STATES.some((state) => !states.includes(state))
  ) {
    semanticMismatch();
  }

  const principal = manifest.fakePrincipal;
  assertOpaque(principal.actorId, 'actor');
  assertOpaque(principal.sessionId, 'session');
  assertOpaque(principal.deploymentId, 'deployment');
  assertOpaque(principal.bootId, 'boot');
  assertOpaque(principal.requestId, 'request');
  assertOpaque(principal.authorizedScope, 'scope');
}

/**
 * Validates already-imported values. It has no transport, filesystem, clock,
 * process, cache, watcher, or production registration behavior.
 */
export function validateSemanticCorpus(
  manifestValue: unknown,
  outcomeValues: readonly unknown[]
): SemanticCorpusSummary {
  if (!isRecord(manifestValue)) semanticMismatch();
  const manifest = manifestValue as unknown as SemanticFixtureManifest;
  assertManifest(manifest);

  if (findSensitivePayloads({ manifest, outcomeValues }).length > 0) {
    throw new TypeError(PATH_SECRET_DIAGNOSTIC);
  }
  if (outcomeValues.length !== manifest.vectors.length) semanticMismatch();

  const fixtures = outcomeValues.map((value, index) => {
    if (!isRecord(value)) semanticMismatch();
    const fixture = value as unknown as SemanticOutcomeFixture;
    const vector = manifest.vectors[index];
    if (
      fixture.schemaVersion !== 1 ||
      fixture.vectorId !== vector.vectorId ||
      fixture.auditedState !== vector.auditedState ||
      !Array.isArray(fixture.oracles) ||
      fixture.oracles.length === 0
    ) {
      semanticMismatch();
    }
    for (const oracle of fixture.oracles) {
      if (oracle.kind === 'success') assertSuccess(oracle);
      else if (oracle.kind === 'failure') assertFailure(oracle);
      else if (oracle.kind !== 'rejected') semanticMismatch();
    }
    assertStateSemantics(fixture);
    return fixture;
  });

  return Object.freeze({
    corpusId: manifest.corpusId,
    vectorIds: Object.freeze(fixtures.map((fixture) => fixture.vectorId)),
    serializedOracle: JSON.stringify(fixtures),
  });
}

const SENSITIVE_VALUE =
  /(?:\/(?:Users|home|root)\/|[A-Za-z]:\\Users\\|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9]|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|auth[_-]?payload|provider[_-]?payload|raw[_-]?(?:command|runtime)[_-]?body)\b)/i;
const SENSITIVE_KEY =
  /^(?:path|(?:host|project|runtime|file|filesystem)Path|root|(?:host|project|runtime)Root|cwd|command|commandBody|runtimeBody|token|(?:api|access|refresh)[_-]?token|password|cookie|auth[_-]?payload|provider[_-]?payload)$/i;

export function findSensitivePayloads(value: unknown): readonly string[] {
  const findings: string[] = [];
  const visit = (entry: unknown, location: string): void => {
    if (typeof entry === 'string') {
      if (SENSITIVE_VALUE.test(entry)) findings.push(location);
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    if (!isRecord(entry)) return;
    for (const [key, item] of Object.entries(entry)) {
      const next = `${location}.${key}`;
      if (SENSITIVE_KEY.test(key)) findings.push(next);
      visit(item, next);
    }
  };
  visit(value, '$');
  return Object.freeze([...new Set(findings)]);
}
