import { describe, expect, it } from 'vitest';

import manifest from '../../../../fixtures/hosted-web/phase-1/team-lifecycle/manifest.json';
import corrupt from '../../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/corrupt.json';
import draft from '../../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/draft.json';
import empty from '../../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/empty.json';
import notFound from '../../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/not-found-inapplicable.json';
import partial from '../../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/partial.json';
import provisioning from '../../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/provisioning-inapplicable.json';
import stale from '../../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/stale.json';
import success from '../../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/success.json';
import unavailable from '../../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unavailable.json';
import unexpected from '../../../../fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unexpected.json';
import { buildPathSecretLeakFixture } from '../fixtures/path-secret-leak';

import {
  findSensitivePayloads,
  PATH_SECRET_DIAGNOSTIC,
  SEMANTIC_CORPUS_DIAGNOSTIC,
  validateSemanticCorpus,
} from './semantic-harness';

const outcomes: readonly unknown[] = [
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
];

describe('P1.1C semantic fixture harness', () => {
  it('validates every audited state deterministically from already-imported values', () => {
    const first = validateSemanticCorpus(manifest, outcomes);
    const second = validateSemanticCorpus(manifest, outcomes);

    expect(second).toEqual(first);
    expect(first.vectorIds).toEqual([
      'success',
      'empty',
      'not-found-inapplicable',
      'draft',
      'provisioning-inapplicable',
      'corrupt',
      'partial',
      'unavailable',
      'stale',
      'unexpected',
    ]);
    expect(first.serializedOracle).not.toContain('teamName');
    expect(first.serializedOracle).not.toContain('projectPath');
  });

  it('fails changed ordering and omitted audited vectors', () => {
    const reversedSuccess = structuredClone(success);
    reversedSuccess.oracles[0].page.items.reverse();

    expect(() => validateSemanticCorpus(manifest, [reversedSuccess, ...outcomes.slice(1)])).toThrow(
      SEMANTIC_CORPUS_DIAGNOSTIC
    );
    expect(() => validateSemanticCorpus(manifest, outcomes.slice(1))).toThrow(
      SEMANTIC_CORPUS_DIAGNOSTIC
    );
  });

  it('rejects the path and credential canary with the frozen diagnostic', () => {
    const leak = buildPathSecretLeakFixture();

    expect(findSensitivePayloads(leak)).toEqual(['$.diagnostic', '$.access_token']);
    expect(() => validateSemanticCorpus(manifest, [leak, ...outcomes.slice(1)])).toThrow(
      PATH_SECRET_DIAGNOSTIC
    );
  });
});
