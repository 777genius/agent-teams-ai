import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { format } from 'prettier';

import {
  runEffectRecoveryScheduler,
  runSnapshotScheduler,
  validateCommandCatalog,
} from './model.mjs';
import {
  buildMutationCensusEvidence,
  verifyCrossLaneOwnerAgreement,
  verifyMutationCensus,
} from './mutation-census.mjs';
import {
  buildEstimate,
  buildEventInventory,
  buildFingerprintGoldens,
  buildReport,
  exactEffectScheduleMatches,
} from './recovery-evidence-builders.mjs';
import { resolveMutationCensusSourceSnapshotSha256 } from './source-revision-provenance.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '../../../..');
const OUT = resolve(ROOT, 'docs/research/hosted-web/phase-0/recovery-events');
const MUTATION_MANIFEST_REPO_PATH =
  'docs/research/hosted-web/phase-0/recovery-events/mutation-surface-manifest.json';
const MUTATION_MANIFEST_PATH = resolve(ROOT, MUTATION_MANIFEST_REPO_PATH);
const W1_API_PARITY_LEDGER_REPO_PATH =
  'docs/research/hosted-web/phase-0/parity-renderer/api-parity-ledger.json';
const W1_API_PARITY_LEDGER_PATH = resolve(ROOT, W1_API_PARITY_LEDGER_REPO_PATH);
const FINGERPRINT_ORACLE_PATH = resolve(
  ROOT,
  'test/architecture/hosted-web/phase-0/recovery-events/fixtures/fingerprint-oracle-vectors.json'
);

async function renderOutputs(buildCommandCatalog) {
  const mutationManifest = JSON.parse(await readFile(MUTATION_MANIFEST_PATH, 'utf8'));
  const mutationCensusSourceSnapshotSha256 = await resolveMutationCensusSourceSnapshotSha256({
    root: ROOT,
    sourceScopes: mutationManifest.sourceScopes ?? [],
  });
  const w1ApiParityLedger = JSON.parse(await readFile(W1_API_PARITY_LEDGER_PATH, 'utf8'));
  const fingerprintOracle = JSON.parse(await readFile(FINGERPRINT_ORACLE_PATH, 'utf8'));
  const catalog = buildCommandCatalog(mutationManifest);
  const censusVerification = await verifyMutationCensus({
    root: ROOT,
    manifest: mutationManifest,
    catalog,
  });
  if (censusVerification.errors.length) {
    throw new Error(`Mutation census invalid:\n${censusVerification.errors.join('\n')}`);
  }
  const crossLaneOwnerVerification = verifyCrossLaneOwnerAgreement({
    w1Ledger: w1ApiParityLedger,
    manifest: mutationManifest,
    catalog,
  });
  if (crossLaneOwnerVerification.errors.length) {
    throw new Error(
      `W1-to-W5 command owner drift:\n${crossLaneOwnerVerification.errors.join('\n')}`
    );
  }
  catalog.coverage.observedSurfaceCount = censusVerification.counts.extracted;
  catalog.coverage.observedMethodCount = censusVerification.counts.required;
  catalog.coverage.dispositionCounts = censusVerification.counts;
  catalog.coverage.sourceFiles = [
    ...new Set(mutationManifest.rows.map((entry) => entry.sourceFile)),
  ];
  catalog.coverage.sourceToManifestComplete = true;
  catalog.coverage.manifestToSourceComplete = true;
  catalog.coverage.exactlyOnceMapped = true;
  catalog.coverage.noCatalogMethodOutsideRequiredDisposition = true;
  catalog.coverage.ownerAgreement = true;
  catalog.coverage.crossLaneOwnership = {
    authorityArtifact: 'docs/research/hosted-web/phase-0/parity-renderer/api-parity-ledger.json',
    authorityEvidenceId: w1ApiParityLedger.evidenceId,
    ...crossLaneOwnerVerification.counts,
    ownerAgreement: true,
  };
  const errors = validateCommandCatalog(catalog);
  if (errors.length) throw new Error(`Command catalog invalid:\n${errors.join('\n')}`);
  const scheduler = runSnapshotScheduler();
  if (
    scheduler.schedules.some(
      (schedule) => !schedule.converged || schedule.gap || schedule.restartCount !== 1
    )
  ) {
    throw new Error('An accepted snapshot schedule did not converge');
  }
  if (scheduler.schedules.some((schedule) => schedule.mutationCommitTransitions.length !== 2)) {
    throw new Error('A snapshot schedule labeled commit without a real before/after transition');
  }
  if (scheduler.negativeControls.some((control) => !control.reproduced || !control.gap)) {
    throw new Error('A required negative schedule did not reproduce its gap');
  }
  const eventInventory = buildEventInventory();
  const effectRecovery = runEffectRecoveryScheduler();
  if (effectRecovery.schedules.some((schedule) => schedule.duplicateEffect)) {
    throw new Error('An effect recovery schedule repeated an external effect');
  }
  if (
    effectRecovery.schedules.some(
      (schedule) =>
        schedule.restartCount !== 1 ||
        schedule.attemptExitCode !== 86 ||
        schedule.recoveryExitCode !== 0 ||
        !schedule.freshProcess ||
        schedule.committedWithoutEvidence
    )
  ) {
    throw new Error(
      'An effect schedule did not perform one durable restart or committed without evidence'
    );
  }
  if (
    effectRecovery.negativeControls.some(
      (control) => control.outcome !== 'operator_required' || control.retryAttempted
    )
  ) {
    throw new Error('An effect negative control did not fail closed');
  }
  if (effectRecovery.schedules.some((schedule) => !exactEffectScheduleMatches(schedule))) {
    throw new Error('An effect schedule did not match its exact post-restart state/effect counts');
  }
  const effectRecoveryEvidence = {
    ...effectRecovery,
    assertions: {
      realAttemptExitAtEveryBoundary: true,
      freshRecoveryProcessEverySchedule: true,
      exactPostRestartStateAndCounts: true,
    },
    schedules: effectRecovery.schedules.map(({ processIds, ...schedule }) => ({
      ...schedule,
      processCount: processIds.length,
    })),
  };
  const effectMatrix = {
    schemaVersion: 1,
    evidenceId: 'P0.W5.EFFECT_RECOVERY_MATRIX',
    stateMachine:
      'not_started -> attempting -> observed_succeeded | observed_absent | ambiguous; compensating -> compensated | ambiguous',
    retryRule:
      'attempting is persisted before the boundary; retry only after descriptor proof establishes deduplication or absence',
    proofScope:
      'fresh Node process crash/restart fixture with durable command and independent external-adapter files; individual catalog rows admit automatic recovery only when automaticRecoveryAdmitted is true',
    ownershipAssertions: {
      everyEffectHasOwner: catalog.commands.every((command) =>
        command.effects.every((effect) => Boolean(effect.effectOwner))
      ),
      everyCoordinatorOwnedByCommandFeature: catalog.commands.every((command) =>
        command.effects
          .filter((effect) => effect.effectRole === 'coordinator_effect')
          .every((effect) => effect.effectOwner === command.featureOwner)
      ),
      everyEffectHasWriterEvidence: catalog.commands.every((command) =>
        command.effects.every((effect) => effect.writerAuthority && effect.writerEvidenceRef)
      ),
      unprovedEffectsFailClosed: catalog.commands.every((command) =>
        command.effects.every(
          (effect) =>
            effect.automaticRecoveryAdmitted ||
            effect.currentRecoveryDisposition.startsWith('operator_required')
        )
      ),
    },
    faultScheduler: effectRecoveryEvidence,
    effects: catalog.commands.flatMap((command) =>
      command.effects.map((effect) => ({ commandKind: command.commandKind, ...effect }))
    ),
  };
  const goldens = buildFingerprintGoldens(fingerprintOracle);
  const estimate = buildEstimate();
  const mutationCensus = buildMutationCensusEvidence({
    manifest: mutationManifest,
    verification: censusVerification,
    crossLaneVerification: crossLaneOwnerVerification,
    sourceSnapshotSha256: mutationCensusSourceSnapshotSha256,
  });
  const index = {
    schemaVersion: 1,
    laneId: 'w5',
    packetRevision: 'phase-00-r2',
    phaseStartSha: 'a32f509e6d9bd31ba2135940e336729bf90c3d93',
    supportingArtifacts: [
      { id: 'P0.W5.SUPPORTING.MUTATION_CENSUS', path: 'mutation-census.json' },
      {
        id: 'P0.W5.SUPPORTING.MUTATION_SURFACE_MANIFEST',
        path: 'mutation-surface-manifest.json',
      },
    ],
    evidence: [
      ['P0.W5.EVENT_CURSOR_INVENTORY', 'event-cursor-inventory.json'],
      ['P0.W5.SNAPSHOT_HANDOFF_SCHEDULER', 'snapshot-handoff-scheduler.json'],
      ['P0.W5.COMMAND_CATALOG', 'command-catalog.json'],
      ['P0.W5.EFFECT_RECOVERY_MATRIX', 'effect-recovery-matrix.json'],
      ['P0.W5.FINGERPRINT_GOLDENS', 'fingerprint-goldens.json'],
      ['P0.W5.ESTIMATE', 'estimate-input.json'],
    ].map(([id, path]) => ({ id, path })),
  };
  const json = (value, spacing) => `${JSON.stringify(value, null, spacing)}\n`;
  const prettierJson = (value) =>
    format(JSON.stringify(value), { parser: 'json', printWidth: 100, trailingComma: 'none' });
  return new Map([
    ['index.json', json(index)],
    ['event-cursor-inventory.json', json(eventInventory)],
    ['snapshot-handoff-scheduler.json', json(scheduler)],
    ['command-catalog.json', await prettierJson(catalog)],
    ['effect-recovery-matrix.json', json(effectMatrix, 2)],
    ['fingerprint-goldens.json', json(goldens)],
    ['estimate-input.json', json(estimate)],
    ['mutation-census.json', json(mutationCensus, 2)],
    ['README.md', buildReport({ catalog, scheduler, effectMatrix, goldens })],
  ]);
}

export async function runRecoveryEvidenceGenerator(buildCommandCatalog, check) {
  const outputs = await renderOutputs(buildCommandCatalog);
  await mkdir(OUT, { recursive: true });
  const mismatches = [];
  for (const [relative, content] of outputs) {
    const target = resolve(OUT, relative);
    if (check) {
      const existing = await readFile(target, 'utf8').catch(() => null);
      if (existing !== content) mismatches.push(relative);
    } else {
      await writeFile(target, content, 'utf8');
    }
  }
  if (mismatches.length)
    throw new Error(`Generated W5 evidence is stale: ${mismatches.join(', ')}`);
  process.stdout.write(`${check ? 'verified' : 'generated'} ${outputs.size} W5 evidence files\n`);
}
