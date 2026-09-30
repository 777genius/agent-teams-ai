import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
const evidence = JSON.parse(
  readFileSync(
    path.join(
      repositoryRoot,
      'docs/research/hosted-web/phase-0/final-gate/typecheck-evidence-reconciliation.json'
    ),
    'utf8'
  )
);
const baseline = JSON.parse(
  readFileSync(
    path.join(
      repositoryRoot,
      'docs/research/hosted-web/phase-0/final-gate/inherited-typescript-diagnostics.json'
    ),
    'utf8'
  )
);
const violations = [];

function assertEqual(id, actual, expected) {
  if (actual !== expected) violations.push({ id, expected, actual });
}

assertEqual('canonical_head', process.env.PHASE0_RECONCILIATION_HEAD, evidence.canonicalHead);
assertEqual('baseline_base', baseline.baseSha, evidence.canonicalHead);
assertEqual(
  'source_classification',
  baseline.sourceClassification.classification,
  evidence.baselineSourceClassification.classification
);
assertEqual(
  'classification_observed_base',
  baseline.sourceClassification.observedAtBaseSha,
  evidence.canonicalHead
);

const facts = [
  ...evidence.baselineSourceClassification.sourceBlobs,
  ...evidence.unchangedRootTypecheckInputs,
];
for (const [index, fact] of facts.entries()) {
  assertEqual(
    `prior_blob:${fact.path}`,
    process.env[`PHASE0_RECONCILIATION_${index}_PRIOR`],
    fact.priorBlob
  );
  assertEqual(
    `head_blob:${fact.path}`,
    process.env[`PHASE0_RECONCILIATION_${index}_HEAD`],
    fact.updatedBaseBlob
  );
  assertEqual(`blob_continuity:${fact.path}`, fact.updatedBaseBlob, fact.priorBlob);
}

const diagnosticCounts = new Map();
for (const diagnostic of baseline.diagnostics) {
  diagnosticCounts.set(diagnostic.file, (diagnosticCounts.get(diagnostic.file) ?? 0) + 1);
}
assertEqual('diagnostic_total', baseline.diagnostics.length, 7);
for (const source of evidence.baselineSourceClassification.sourceBlobs) {
  assertEqual(
    `diagnostic_count:${source.path}`,
    diagnosticCounts.get(source.path),
    source.diagnosticCount
  );
}
assertEqual('targeted_observed', evidence.freshTargetedObservation.observedDiagnosticCount, 7);
assertEqual('targeted_inherited', evidence.freshTargetedObservation.normalizedInheritedCount, 7);
// Older evidence carries unexpectedDiagnosticCount; the current normalizer emits the
// unexpectedDiagnostics array instead. Accept either so regenerated evidence reconciles.
assertEqual(
  'targeted_unexpected',
  evidence.freshTargetedObservation.unexpectedDiagnosticCount ??
    (Array.isArray(evidence.freshTargetedObservation.unexpectedDiagnostics)
      ? evidence.freshTargetedObservation.unexpectedDiagnostics.length
      : undefined),
  0
);
assertEqual('targeted_effective', evidence.freshTargetedObservation.effectiveDiagnosticCount, 0);

const report = {
  schemaVersion: 1,
  gate: 'phase-0-final-gate-typecheck-reconciliation',
  passed: violations.length === 0,
  canonicalHead: evidence.canonicalHead,
  classification: evidence.baselineSourceClassification.classification,
  diagnosticCount: baseline.diagnostics.length,
  violations,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.passed ? 0 : 1;
