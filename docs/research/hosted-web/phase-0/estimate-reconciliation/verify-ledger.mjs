#!/usr/bin/env node
/* global console, process */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const artifactDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(artifactDir, '../../../../..');
const ledger = JSON.parse(readFileSync(resolve(artifactDir, 'estimate-ledger.json'), 'utf8'));
JSON.parse(readFileSync(resolve(artifactDir, 'estimate-ledger.schema.json'), 'utf8'));

const failures = [];
const fail = (message) => failures.push(message);
const rangeKeys = ['low', 'high'];
const componentKeys = [
  'implementationAdditions',
  'testsAndEvidenceAdditions',
  'deletedLegacyLines',
  'unallocatedMixedScope',
];

const assertRange = (range, label) => {
  if (!range || !Number.isInteger(range.low) || !Number.isInteger(range.high)) {
    fail(label + ' is not an integer range');
    return;
  }
  if (range.low < 0 || range.high < range.low) {
    fail(label + ' has invalid bounds ' + range.low + '-' + range.high);
  }
};

const sumRanges = (ranges) =>
  Object.fromEntries(
    rangeKeys.map((key) => [key, ranges.reduce((sum, range) => sum + range[key], 0)])
  );

const sumComponents = (components) =>
  Object.fromEntries(
    componentKeys.map((componentKey) => [
      componentKey,
      sumRanges(components.map((component) => component[componentKey])),
    ])
  );

const assertSameRange = (actual, expected, label) => {
  for (const key of rangeKeys) {
    if (actual[key] !== expected[key]) {
      fail(label + '.' + key + ': expected ' + expected[key] + ', found ' + actual[key]);
    }
  }
};

const assertSameComponents = (actual, expected, label) => {
  for (const componentKey of componentKeys) {
    assertSameRange(actual[componentKey], expected[componentKey], label + '.' + componentKey);
  }
};

const assertSameStringSet = (actual, expected, label) => {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((value) => !actualSet.has(value));
  const extra = [...actualSet].filter((value) => !expectedSet.has(value));
  if (actualSet.size !== actual.length || missing.length > 0 || extra.length > 0) {
    fail(
      label + ' mismatch: missing [' + missing.join(', ') + '], extra [' + extra.join(', ') + ']'
    );
  }
};

const componentGrandTotal = (components) =>
  sumRanges(componentKeys.map((componentKey) => components[componentKey]));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (args) =>
  execFileSync('git', args, {
    cwd: repoRoot,
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const verifyCommit = (commit, label) => {
  try {
    git(['cat-file', '-e', commit + '^{commit}']);
  } catch {
    fail(label + ' does not resolve to a commit: ' + commit);
  }
};

verifyCommit(ledger.asOfCommit, 'asOfCommit');
verifyCommit(ledger.targetHeadCommit, 'targetHeadCommit');
if (ledger.asOfCommit === ledger.targetHeadCommit) {
  fail('asOfCommit and targetHeadCommit must identify distinct source and target snapshots');
}
try {
  git(['merge-base', '--is-ancestor', ledger.asOfCommit, ledger.targetHeadCommit]);
} catch {
  fail('asOfCommit is not an ancestor of targetHeadCommit');
}
if (
  ledger.provenance?.sourceSnapshot?.commitField !== 'asOfCommit' ||
  ledger.provenance?.sourceSnapshot?.classification !== 'source_snapshot' ||
  ledger.provenance?.targetSnapshot?.commitField !== 'targetHeadCommit' ||
  ledger.provenance?.targetSnapshot?.classification !== 'target_candidate' ||
  ledger.provenance?.headPolicy !== 'pinned_snapshots_no_head_equality' ||
  ledger.provenance?.ancestryPolicy !== 'source_snapshot_must_be_ancestor_of_target_candidate' ||
  ledger.provenance?.authority?.artifactStatus !== 'current_candidate_not_canonical' ||
  ledger.provenance?.authority?.reviewDisposition !== 'pending' ||
  ledger.provenance?.authority?.canonicalEntrypoint !== 'docs/hosted-web-phases/START_HERE.md' ||
  ledger.provenance?.authority?.evidenceLifecycle !==
    'docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md' ||
  ledger.provenance?.authority?.supersededRejectedArtifact !== 'estimate-candidate-reconcile-h4'
) {
  fail('ledger provenance and authority policy is incomplete or claims canonical authority');
}

const snapshotCommitFor = (source) =>
  source.provenanceClass === 'source_snapshot'
    ? ledger.asOfCommit
    : source.provenanceClass === 'target_candidate'
      ? ledger.targetHeadCommit
      : null;

const readSourceBytes = (source) => {
  const commit = snapshotCommitFor(source);
  if (!commit) return null;
  try {
    return git(['show', commit + ':' + source.path]);
  } catch {
    fail(
      'source cannot be reproduced from ' +
        source.provenanceClass +
        ' at ' +
        commit +
        ': ' +
        source.path
    );
    return null;
  }
};

const sourceIds = new Set();
const expectedTargetCandidateSourceIds = new Set([
  'P0.W6.AUTH_ARTIFACT_EVIDENCE',
  'P0.W6.ARTIFACT_MANIFEST',
]);
const provenanceCounts = new Map([
  ['source_snapshot', 0],
  ['target_candidate', 0],
]);
for (const source of ledger.sources) {
  if (sourceIds.has(source.sourceId)) fail('duplicate sourceId ' + source.sourceId);
  sourceIds.add(source.sourceId);
  if (source.path.startsWith('/') || source.path.split('/').includes('..')) {
    fail('source path is not repository-relative: ' + source.path);
    continue;
  }
  if (!provenanceCounts.has(source.provenanceClass)) {
    fail('source has unknown provenanceClass: ' + source.sourceId);
  } else {
    provenanceCounts.set(source.provenanceClass, provenanceCounts.get(source.provenanceClass) + 1);
  }
  const expectedClass = expectedTargetCandidateSourceIds.has(source.sourceId)
    ? 'target_candidate'
    : 'source_snapshot';
  if (source.provenanceClass !== expectedClass) {
    fail(source.sourceId + ' must be classified ' + expectedClass);
  }
  const sourceBytes = readSourceBytes(source);
  if (!sourceBytes) continue;
  const actualHash = sha256(sourceBytes);
  if (actualHash !== source.sha256) {
    fail(
      'source hash mismatch for ' +
        source.path +
        ': expected ' +
        source.sha256 +
        ', found ' +
        actualHash
    );
  }
}
if (ledger.sources.length !== 23) fail('expected exactly 23 classified source hashes');
if (provenanceCounts.get('source_snapshot') !== 21) {
  fail('expected 21 source_snapshot hashes');
}
if (provenanceCounts.get('target_candidate') !== 2) {
  fail('expected 2 target_candidate hashes');
}

const expectedBucketIds = new Set([
  'EST-CONTRACTS',
  'EST-IDENTITY-WORKSPACE',
  'EST-LIFECYCLE-RUNTIME',
  'EST-RECOVERY-STATE',
  'EST-COMMAND-EVENT-RECOVERY',
  'EST-HOSTED-OPS',
  'EST-RENDERER-LIFECYCLE',
  'EST-REMAINING-PARITY',
  'EST-RELEASE-E2E',
]);
const expectedBaselineConfidence = new Map([
  ['EST-CONTRACTS', 'high'],
  ['EST-IDENTITY-WORKSPACE', 'medium'],
  ['EST-LIFECYCLE-RUNTIME', 'medium'],
  ['EST-RECOVERY-STATE', 'medium-low'],
  ['EST-COMMAND-EVENT-RECOVERY', 'medium-low'],
  ['EST-HOSTED-OPS', 'medium'],
  ['EST-RENDERER-LIFECYCLE', 'medium'],
  ['EST-REMAINING-PARITY', 'medium-low'],
  ['EST-RELEASE-E2E', 'medium'],
]);
const bucketIds = new Set();
const allocationOwners = new Map();

for (const bucket of ledger.buckets) {
  if (!expectedBucketIds.has(bucket.bucketId)) fail('unexpected bucket ' + bucket.bucketId);
  if (bucketIds.has(bucket.bucketId)) fail('duplicate bucket ' + bucket.bucketId);
  bucketIds.add(bucket.bucketId);
  assertRange(bucket.baseline, bucket.bucketId + '.baseline');
  assertRange(bucket.reconciled, bucket.bucketId + '.reconciled');

  for (const key of componentKeys)
    assertRange(bucket.components[key], bucket.bucketId + '.components.' + key);
  assertSameRange(
    bucket.reconciled,
    componentGrandTotal(bucket.components),
    bucket.bucketId + '.component sum'
  );

  for (const allocationKey of bucket.allocationKeys) {
    const previous = allocationOwners.get(allocationKey);
    if (previous)
      fail(
        'allocation key ' +
          allocationKey +
          ' is owned by both ' +
          previous +
          ' and ' +
          bucket.bucketId
      );
    allocationOwners.set(allocationKey, bucket.bucketId);
  }

  for (const sourceId of bucket.sourceIds) {
    if (!sourceIds.has(sourceId)) fail(bucket.bucketId + ' references unknown source ' + sourceId);
  }
  for (const sourceId of [
    ...bucket.deduplication.includedSourceIds,
    ...bucket.deduplication.excludedNumericSourceIds,
  ]) {
    if (!sourceIds.has(sourceId))
      fail(bucket.bucketId + ' deduplication references unknown source ' + sourceId);
  }

  for (const key of rangeKeys) {
    const baseline = bucket.baseline[key];
    const expectedVariance = ((bucket.reconciled[key] - baseline) / baseline) * 100;
    const recordedVariance = bucket.variance[key + 'Percent'];
    if (Math.abs(recordedVariance - expectedVariance) > 0.01) {
      fail(
        bucket.bucketId +
          ' ' +
          key +
          ' variance expected ' +
          expectedVariance +
          ', found ' +
          recordedVariance
      );
    }
  }
  const expectedTrigger =
    Math.abs(bucket.variance.lowPercent) > 20 || Math.abs(bucket.variance.highPercent) > 20;
  if (bucket.variance.overTwentyPercent !== expectedTrigger) {
    fail(bucket.bucketId + ' overTwentyPercent does not match its variance');
  }

  const baselineConfidence = expectedBaselineConfidence.get(bucket.bucketId);
  if (bucket.confidence.baseline.rating !== baselineConfidence) {
    fail(
      bucket.bucketId +
        ' baseline confidence expected ' +
        baselineConfidence +
        ', found ' +
        bucket.confidence.baseline.rating
    );
  }
  if (bucket.confidence.baseline.sourceId !== 'P0.BASELINE_ESTIMATE') {
    fail(bucket.bucketId + ' confidence does not cite the parent baseline');
  }
  const changed = bucket.confidence.baseline.rating !== bucket.confidence.reconciled.rating;
  if (bucket.confidence.changed !== changed) {
    fail(bucket.bucketId + ' confidence.changed does not match its ratings');
  }
  if (!bucket.confidence.reason.trim())
    fail(bucket.bucketId + ' confidence transition reason is empty');
}

for (const expectedBucketId of expectedBucketIds) {
  if (!bucketIds.has(expectedBucketId)) fail('missing bucket ' + expectedBucketId);
}

const byId = new Map(ledger.buckets.map((bucket) => [bucket.bucketId, bucket]));
const readJsonSource = (sourceId) => {
  const source = ledger.sources.find((candidate) => candidate.sourceId === sourceId);
  const sourceBytes = readSourceBytes(source);
  if (!sourceBytes) return {};
  return JSON.parse(sourceBytes.toString('utf8'));
};

const allocationById = new Map();
for (const allocation of ledger.allocationReconciliation.allocations) {
  if (allocationById.has(allocation.allocationId)) {
    fail('duplicate reconciliation allocation ' + allocation.allocationId);
  }
  allocationById.set(allocation.allocationId, allocation);
  if (!sourceIds.has(allocation.sourceId))
    fail(allocation.allocationId + ' references unknown source ' + allocation.sourceId);
  if (!bucketIds.has(allocation.ownerBucketId))
    fail(allocation.allocationId + ' references unknown owner bucket ' + allocation.ownerBucketId);
  for (const sourceId of allocation.basisSourceIds) {
    if (!sourceIds.has(sourceId))
      fail(allocation.allocationId + ' references unknown basis source ' + sourceId);
  }
  for (const componentKey of componentKeys) {
    assertRange(
      allocation.components[componentKey],
      allocation.allocationId + '.components.' + componentKey
    );
  }
  if (allocation.numericDisposition === 'included_unique') {
    if (!byId.get(allocation.ownerBucketId).allocationKeys.includes(allocation.allocationId)) {
      fail(allocation.allocationId + ' is not an allocation key of ' + allocation.ownerBucketId);
    }
    if (allocation.coveredByAllocationIds.length !== 0) {
      fail(allocation.allocationId + ' is included but declares overlap coverage');
    }
  } else if (allocation.coveredByAllocationIds.length === 0) {
    fail(allocation.allocationId + ' excludes overlap without naming included coverage');
  }
}

for (const allocation of ledger.allocationReconciliation.allocations) {
  for (const coveredId of allocation.coveredByAllocationIds) {
    const covered = allocationById.get(coveredId);
    if (!covered || covered.numericDisposition !== 'included_unique') {
      fail(allocation.allocationId + ' has invalid overlap coverage ' + coveredId);
    }
    if (covered && covered.ownerBucketId !== allocation.ownerBucketId) {
      fail(allocation.allocationId + ' coverage ' + coveredId + ' has a different owner bucket');
    }
  }
}

const w1 = readJsonSource('P0.W1.ESTIMATE');
for (const sourceBucket of w1.buckets) {
  const expected = {
    low:
      sourceBucket.productionLines.low + sourceBucket.testLines.low + sourceBucket.deletedLines.low,
    high:
      sourceBucket.productionLines.high +
      sourceBucket.testLines.high +
      sourceBucket.deletedLines.high,
  };
  assertSameRange(
    byId.get(sourceBucket.bucketId).reconciled,
    expected,
    sourceBucket.bucketId + ' W1 normalization'
  );
}

const w2 = readJsonSource('P0.W2.ESTIMATE');
const w2Components = {
  implementationAdditions: {
    low: w2.ranges.productionLines.low,
    high: w2.ranges.productionLines.high,
  },
  testsAndEvidenceAdditions: { low: w2.ranges.testLines.low, high: w2.ranges.testLines.high },
  deletedLegacyLines: { low: w2.ranges.deletedLines.low, high: w2.ranges.deletedLines.high },
  unallocatedMixedScope: { low: 0, high: 0 },
};

const w3 = readJsonSource('P0.W3.ESTIMATE');
const w3AllocationIds = new Map([
  ['EST-W3-COMPAT-CATALOG', 'w3-compat-catalog'],
  ['EST-W3-WRITER-COORDINATION', 'w3-writer-coordination'],
  ['EST-W3-SQLITE-BACKUP', 'w3-sqlite-backup'],
  ['EST-W3-BACKUP-PARTICIPANTS', 'w3-backup-participants'],
]);
for (const sourceBucket of w3.buckets) {
  const allocationId = w3AllocationIds.get(sourceBucket.bucketId);
  const allocation = allocationById.get(allocationId);
  if (!allocation) {
    fail('missing W3 allocation for ' + sourceBucket.bucketId);
    continue;
  }
  assertSameComponents(
    allocation.components,
    {
      implementationAdditions: {
        low: sourceBucket.productionLines.min,
        high: sourceBucket.productionLines.max,
      },
      testsAndEvidenceAdditions: {
        low: sourceBucket.testLines.min,
        high: sourceBucket.testLines.max,
      },
      deletedLegacyLines: {
        low: sourceBucket.deletedLines.min,
        high: sourceBucket.deletedLines.max,
      },
      unallocatedMixedScope: { low: 0, high: 0 },
    },
    allocationId + ' source normalization'
  );
  assertSameStringSet(
    allocation.scope,
    sourceBucket.packages,
    allocationId + ' source package coverage'
  );
}
const w3Components = sumComponents(
  [...w3AllocationIds.values()].map((allocationId) => allocationById.get(allocationId).components)
);
assertSameComponents(byId.get('EST-RECOVERY-STATE').components, w3Components, 'W3 allocation sum');

const w5 = readJsonSource('P0.W5.ESTIMATE');
const w5Unique = allocationById.get('w5-command-event-recovery');
const w5Overlap = allocationById.get('w5-shared-storage-transaction-fixtures');
assertSameComponents(
  byId.get('EST-COMMAND-EVENT-RECOVERY').components,
  w5Unique.components,
  'W5 unique bucket'
);
assertSameComponents(
  sumComponents([w5Unique.components, w5Overlap.components]),
  {
    implementationAdditions: { low: w5.productionLines.low, high: w5.productionLines.high },
    testsAndEvidenceAdditions: { low: w5.testLines.low, high: w5.testLines.high },
    deletedLegacyLines: { low: w5.deletedLines.low, high: w5.deletedLines.high },
    unallocatedMixedScope: { low: 0, high: 0 },
  },
  'W5 unique plus excluded overlap'
);
assertSameStringSet(w5Unique.scope, w5.packages, 'W5 unique source package coverage');
if (
  byId.get('EST-RECOVERY-STATE').sourceIds.includes('P0.W5.ESTIMATE') ||
  byId.get('EST-COMMAND-EVENT-RECOVERY').sourceIds.includes('P0.W3.ESTIMATE')
) {
  fail('W3 and W5 source ownership is not separated by bucket');
}

const semanticOverlap = (leftKeys, rightKeys) => {
  const right = new Set(rightKeys);
  return leftKeys.some((key) => right.has(key));
};
const nestedNumericNegativeFixture = {
  containingRange: { low: 4000, high: 9000 },
  nestedRange: { low: 4500, high: 7500 },
  containingAllocationKeys: ['storage-backup'],
  nestedAllocationKeys: ['command-journal'],
};
const fixtureIsNumericallyNested =
  nestedNumericNegativeFixture.containingRange.low <=
    nestedNumericNegativeFixture.nestedRange.low &&
  nestedNumericNegativeFixture.containingRange.high >=
    nestedNumericNegativeFixture.nestedRange.high;
if (!fixtureIsNumericallyNested) fail('nested numeric negative fixture is not nested');
if (
  semanticOverlap(
    nestedNumericNegativeFixture.containingAllocationKeys,
    nestedNumericNegativeFixture.nestedAllocationKeys
  )
) {
  fail('negative fixture incorrectly treats nested numeric ranges as semantic overlap');
}

const w4 = readJsonSource('P0.W4.ESTIMATE');
assertSameStringSet(
  w2.w4Reconciliation.w2ExcludesAsW4Owned,
  [
    'instance lease',
    'workspace guard',
    'process anchor',
    'native helper build and final-image probes',
  ],
  'W2-declared W4 executable scope'
);
for (const value of Object.values(w4.admittedR3Lines)) {
  if (value !== 0) fail('W4 characterized r3 source unexpectedly admits numeric lines');
}
if (!w4.historicalR2Range.disposition.startsWith('not admitted')) {
  fail('W4 historical range is no longer explicitly not admitted');
}
const w4Ids = [
  'w4-workspace-guard',
  'w4-instance-lease',
  'w4-process-anchor',
  'w4-native-helper-build',
  'w4-final-image-probes',
];
for (const allocationId of w4Ids) {
  const allocation = allocationById.get(allocationId);
  if (!allocation || allocation.estimateMethod !== 'controller_scope_estimate') {
    fail('missing controller scope estimate ' + allocationId);
  }
}
const w4Allocations = w4Ids.map((allocationId) => allocationById.get(allocationId));
assertSameRange(
  componentGrandTotal(sumComponents(w4Allocations.map((entry) => entry.components))),
  { low: 4500, high: 7650 },
  'complete W4 executable scope'
);
const w4LifecycleComponents = sumComponents(
  w4Allocations
    .filter((allocation) => allocation.ownerBucketId === 'EST-LIFECYCLE-RUNTIME')
    .map((allocation) => allocation.components)
);
assertSameComponents(
  byId.get('EST-LIFECYCLE-RUNTIME').components,
  sumComponents([w2Components, w4LifecycleComponents]),
  'W2 plus W4 lifecycle/runtime'
);
const w4Guard = allocationById.get('w4-workspace-guard');
for (const componentKey of componentKeys.filter((key) => key !== 'unallocatedMixedScope')) {
  assertSameRange(
    byId.get('EST-IDENTITY-WORKSPACE').components[componentKey],
    w4Guard.components[componentKey],
    'identity/workspace ' + componentKey + ' W4 guard'
  );
}

const w6 = readJsonSource('P0.W6.ESTIMATE');
assertSameRange(
  byId.get('EST-HOSTED-OPS').reconciled,
  {
    low: w6.lines.production.low + w6.lines.test.low + w6.lines.deleted.low,
    high: w6.lines.production.high + w6.lines.test.high + w6.lines.deleted.high,
  },
  'W6 gross normalization'
);

assertSameRange(
  ledger.totals.baselineV1,
  sumRanges(ledger.buckets.map((bucket) => bucket.baseline)),
  'baseline total'
);
assertSameRange(
  ledger.totals.reconciledV1,
  sumRanges(ledger.buckets.map((bucket) => bucket.reconciled)),
  'reconciled total'
);
for (const componentKey of componentKeys) {
  assertSameRange(
    ledger.totals.knownComponents[componentKey],
    sumRanges(ledger.buckets.map((bucket) => bucket.components[componentKey])),
    'component total ' + componentKey
  );
}
assertSameRange(
  ledger.totals.reconciledV1,
  componentGrandTotal(ledger.totals.knownComponents),
  'component grand total'
);
for (const key of rangeKeys) {
  const baseline = ledger.totals.baselineV1[key];
  const expectedVariance = ((ledger.totals.reconciledV1[key] - baseline) / baseline) * 100;
  if (Math.abs(ledger.totals.variance[key + 'Percent'] - expectedVariance) > 0.01) {
    fail('total ' + key + ' variance does not match arithmetic');
  }
}
const totalConfidence = ledger.totals.confidence;
if (
  totalConfidence.baseline.score !== 7 ||
  totalConfidence.baseline.scale !== 10 ||
  totalConfidence.baseline.sourceId !== 'P0.BASELINE_ESTIMATE'
) {
  fail('total baseline confidence does not preserve the parent 7/10 provenance');
}
if (totalConfidence.reconciled.score !== 5 || totalConfidence.reconciled.scale !== 10) {
  fail('total reconciled confidence must be the reviewed 5/10 transition');
}
if (
  totalConfidence.changed !==
  (totalConfidence.baseline.score !== totalConfidence.reconciled.score)
) {
  fail('total confidence.changed does not match its scores');
}
if (!totalConfidence.reason.trim()) fail('total confidence transition reason is empty');

for (const deferred of ledger.deferredScope) {
  assertRange(deferred.estimate, deferred.scopeId + '.estimate');
  assertSameRange(
    deferred.v1Contribution,
    { low: 0, high: 0 },
    deferred.scopeId + '.v1Contribution'
  );
}

const activeTriggers = ledger.reviewTriggers.filter((trigger) => trigger.active);
if (ledger.totals.requiresScopeDesignReview !== activeTriggers.length > 0) {
  fail('requiresScopeDesignReview does not match active review triggers');
}
const partialRangeTrigger = ledger.reviewTriggers.find(
  (trigger) => trigger.triggerId === 'TOTAL_PARTIALLY_OUTSIDE_PARENT_RANGE'
);
const lowInsideParentInterval =
  ledger.totals.reconciledV1.low >= ledger.totals.baselineV1.low &&
  ledger.totals.reconciledV1.low <= ledger.totals.baselineV1.high;
const highAboveParentInterval = ledger.totals.reconciledV1.high > ledger.totals.baselineV1.high;
if (!lowInsideParentInterval || !highAboveParentInterval || !partialRangeTrigger?.active) {
  fail('partial parent-range semantics do not match the reconciled interval');
}
if (ledger.reviewTriggers.some((trigger) => trigger.triggerId === 'TOTAL_OUTSIDE_PARENT_RANGE')) {
  fail('obsolete total-outside-parent-range trigger is present');
}
if (ledger.status !== 'current_candidate_requires_scope_design_review') {
  fail('unexpected ledger status ' + ledger.status);
}

if (failures.length > 0) {
  for (const failure of failures) console.error('FAIL: ' + failure);
  process.exit(1);
}

console.log(
  'PASS: ' +
    ledger.buckets.length +
    ' unique v1 buckets, ' +
    allocationOwners.size +
    ' unique bucket allocations, ' +
    ledger.allocationReconciliation.allocations.length +
    ' W3/W4/W5 scope allocations, ' +
    ledger.totals.reconciledV1.low +
    '-' +
    ledger.totals.reconciledV1.high +
    ' gross integrated changed lines, confidence ' +
    ledger.totals.confidence.baseline.score +
    '/10->' +
    ledger.totals.confidence.reconciled.score +
    '/10; ' +
    ledger.sources.length +
    ' classified source hashes verified (' +
    provenanceCounts.get('source_snapshot') +
    ' source_snapshot, ' +
    provenanceCounts.get('target_candidate') +
    ' target_candidate) across ' +
    ledger.asOfCommit +
    ' -> ' +
    ledger.targetHeadCommit
);
