import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  encodeIntent,
  fingerprintIntent,
  resolveClaim,
  runEffectRecoveryScheduler,
  runSnapshotScheduler,
  validateCommandCatalog,
} from '../../../../../scripts/hosted-web/phase-0/recovery-events/model.mjs';
import {
  verifyCrossLaneOwnerAgreement,
  verifyMutationCensus,
} from '../../../../../scripts/hosted-web/phase-0/recovery-events/mutation-census.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TEST_DIR, '../../../../..');
const EVIDENCE = resolve(ROOT, 'docs/research/hosted-web/phase-0/recovery-events');
const W1_API_PARITY_LEDGER = resolve(
  ROOT,
  'docs/research/hosted-web/phase-0/parity-renderer/api-parity-ledger.json'
);

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function schemaErrors(document, schema, path = '$') {
  const errors = [];
  const add = (message) => errors.push(`${path} ${message}`);
  if ('const' in schema && !Object.is(document, schema.const))
    add(`must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(document)) add('must match enum');
  if (
    schema.type === 'object' &&
    (document === null || typeof document !== 'object' || Array.isArray(document))
  )
    add('must be object');
  if (schema.type === 'array' && !Array.isArray(document)) add('must be array');
  if (schema.type === 'string' && typeof document !== 'string') add('must be string');
  if (schema.type === 'integer' && !Number.isInteger(document)) add('must be integer');
  if (schema.type === 'boolean' && typeof document !== 'boolean') add('must be boolean');
  if (typeof document === 'number' && schema.minimum != null && document < schema.minimum)
    add(`must be >= ${schema.minimum}`);
  if (typeof document === 'string' && schema.pattern && !new RegExp(schema.pattern).test(document))
    add(`must match ${schema.pattern}`);
  if (Array.isArray(document)) {
    if (schema.minItems != null && document.length < schema.minItems)
      add(`must have >= ${schema.minItems} items`);
    if (schema.maxItems != null && document.length > schema.maxItems)
      add(`must have <= ${schema.maxItems} items`);
    if (schema.items) {
      document.forEach((item, index) =>
        errors.push(...schemaErrors(item, schema.items, `${path}[${index}]`))
      );
    }
  }
  if (document !== null && typeof document === 'object' && !Array.isArray(document)) {
    for (const field of schema.required ?? []) {
      if (!(field in document)) errors.push(`${path}.${field} is required`);
    }
    for (const [field, rule] of Object.entries(schema.properties ?? {})) {
      if (field in document)
        errors.push(...schemaErrors(document[field], rule, `${path}.${field}`));
    }
  }
  for (const rule of schema.allOf ?? []) errors.push(...schemaErrors(document, rule, path));
  if (schema.if && schemaErrors(document, schema.if, path).length === 0 && schema.then) {
    errors.push(...schemaErrors(document, schema.then, path));
  }
  return errors;
}

function validateAgainstSchema(document, schema) {
  assert.deepEqual(schemaErrors(document, schema), []);
}

test('accepted same-transaction and lower-C0 schedules converge at every pause', () => {
  const result = runSnapshotScheduler();
  assert.equal(result.exploredScheduleCount, 288);
  assert.ok(result.schedules.every((schedule) => schedule.converged && !schedule.gap));
  assert.ok(
    result.schedules.some(
      (schedule) => schedule.algorithm === 'external_lower_c0' && schedule.duplicates > 0
    ),
    'lower cursor must exercise harmless duplicate replay'
  );
  for (const pause of result.pauses) {
    assert.ok(
      result.schedules.some(
        (schedule) =>
          schedule.crashPause === pause &&
          schedule.trace.some((entry) => entry.startsWith(`crash:${pause}:`)) &&
          schedule.trace.some((entry) => entry.startsWith('restart:1:'))
      ),
      `crash/restart pause not exercised: ${pause}`
    );
  }
  assert.ok(
    result.schedules.every(
      (schedule) =>
        schedule.restartCount === 1 &&
        schedule.durableBeforeCrash &&
        schedule.durableAfterRestart &&
        schedule.mutationCommitTransitions.length === 2
    ),
    'every schedule must execute one durable crash/restart and a real mutation commit transition'
  );
});

test('negative controls retain both known lost-event schedules', () => {
  const result = runSnapshotScheduler();
  assert.deepEqual(
    result.negativeControls.map(({ id, reproduced, gap }) => ({ id, reproduced, gap })),
    [
      { id: 'negative_cursor_after_read', reproduced: true, gap: true },
      { id: 'negative_query_then_listen', reproduced: true, gap: true },
    ]
  );
});

test('effect recovery fault schedules never repeat an ambiguous external effect', () => {
  const result = runEffectRecoveryScheduler();
  assert.equal(result.exploredScheduleCount, 52);
  assert.ok(
    result.schedules.every(
      (schedule) =>
        schedule.restartCount === 1 &&
        schedule.attemptExitCode === 86 &&
        schedule.recoveryExitCode === 0 &&
        schedule.processIds.length === 2 &&
        schedule.freshProcess &&
        schedule.durableBeforeCrash &&
        schedule.durableAfterRecovery &&
        !schedule.duplicateEffect &&
        !schedule.committedWithoutEvidence &&
        schedule.trace.includes(`crash:${schedule.crashPause}`) &&
        schedule.trace.some((entry) => entry.startsWith('restart:load:'))
    )
  );
  const ambiguousResponseLoss = result.schedules.find(
    (schedule) =>
      schedule.recoveryClass === 'non_reconcilable' && schedule.crashPause === 'after_external_call'
  );
  assert.equal(ambiguousResponseLoss?.externalEffects, 1);
  assert.equal(ambiguousResponseLoss?.outcome, 'operator_required');
  for (const schedule of result.schedules) {
    const isCompensation = schedule.crashPause.includes('compensation');
    const isNonReconcilableAmbiguity =
      schedule.recoveryClass === 'non_reconcilable' &&
      ['before_external_call', 'after_external_call', 'before_evidence_query'].includes(
        schedule.crashPause
      );
    const expectedOutcome = isCompensation
      ? 'compensated'
      : isNonReconcilableAmbiguity
        ? 'operator_required'
        : 'committed';
    const expectedExternalEffects =
      isNonReconcilableAmbiguity && schedule.crashPause === 'before_external_call' ? 0 : 1;
    const expectedExternalAttempts =
      schedule.recoveryClass === 'transactional_local' || expectedExternalEffects === 0 ? 0 : 1;
    const expectedPublications = isNonReconcilableAmbiguity
      ? 0
      : schedule.crashPause === 'after_event_publication'
        ? 2
        : 1;
    assert.deepEqual(
      {
        outcome: schedule.outcome,
        state: schedule.durableAfterRecovery.state,
        commandOutcome: schedule.durableAfterRecovery.commandOutcome,
        journalCommitted: schedule.durableAfterRecovery.journalCommitted,
        externalCallAttempts: schedule.externalCallAttempts,
        externalEffects: schedule.externalEffects,
        compensationAttempts: schedule.compensationAttempts,
        compensationEffects: schedule.compensationEffects,
        publicationAttempts: schedule.publicationAttempts,
      },
      {
        outcome: expectedOutcome,
        state: isCompensation
          ? 'compensated'
          : isNonReconcilableAmbiguity
            ? 'ambiguous'
            : 'observed_succeeded',
        commandOutcome: expectedOutcome,
        journalCommitted: !isNonReconcilableAmbiguity,
        externalCallAttempts: expectedExternalAttempts,
        externalEffects: expectedExternalEffects,
        compensationAttempts: isCompensation ? 1 : 0,
        compensationEffects: isCompensation ? 1 : 0,
        publicationAttempts: expectedPublications,
      },
      `${schedule.recoveryClass}/${schedule.crashPause}`
    );
  }
  for (const pause of result.pauses) {
    assert.ok(
      result.schedules.some((schedule) => schedule.trace.includes(`boundary:${pause}`)),
      `effect pause not exercised: ${pause}`
    );
  }
  assert.ok(
    result.negativeControls.every(
      (control) => control.outcome === 'operator_required' && !control.retryAttempted
    )
  );
});

test('fingerprint encoding matches an immutable oracle and conflicts on changed intent', async () => {
  const key = 'public-test-key';
  const base = {
    descriptorId: 'message.send',
    schemaVersion: 1,
    fingerprintVersion: 'hmac-sha256-ld-v1',
  };
  const left = fingerprintIntent({
    ...base,
    key,
    intent: { teamId: 't', contentDigest: 'sha256:a' },
  });
  const reordered = fingerprintIntent({
    ...base,
    key,
    intent: { contentDigest: 'sha256:a', teamId: 't' },
  });
  const changed = fingerprintIntent({
    ...base,
    key,
    intent: { teamId: 't', contentDigest: 'sha256:b' },
  });
  assert.equal(left, reordered);
  assert.notEqual(left, changed);
  assert.match(encodeIntent({ label: '雪', maximum: Number.MAX_SAFE_INTEGER }), /^o:/);
  assert.throws(() => encodeIntent(Number.MAX_SAFE_INTEGER + 1), /safe integers/);
  const record = { ...base, keyVersion: 'v1', digest: left };
  assert.equal(resolveClaim(record, { ...record }).outcome, 'same_intent');
  assert.equal(
    resolveClaim(record, { ...record, digest: changed }).outcome,
    'idempotency_mismatch'
  );
  const oracle = await json(resolve(TEST_DIR, 'fixtures/fingerprint-oracle-vectors.json'));
  for (const vector of oracle.vectors) {
    const payload = {
      descriptorId: vector.descriptorId,
      schemaVersion: vector.schemaVersion,
      fingerprintVersion: vector.fingerprintVersion,
      intent: vector.intent,
    };
    assert.equal(encodeIntent(payload), vector.expectedEncoding, `${vector.id} encoding`);
    assert.equal(
      fingerprintIntent({ ...payload, key: vector.key }),
      vector.expectedDigest,
      `${vector.id} digest`
    );
  }
});

test('command catalog has bidirectional source census and omission proof', async () => {
  const catalog = await json(resolve(EVIDENCE, 'command-catalog.json'));
  const census = await json(resolve(EVIDENCE, 'mutation-census.json'));
  const manifest = await json(resolve(EVIDENCE, 'mutation-surface-manifest.json'));
  assert.deepEqual(validateCommandCatalog(catalog), []);
  const invalid = await json(resolve(TEST_DIR, 'fixtures/invalid-command-catalog.json'));
  const errors = validateCommandCatalog(invalid);
  assert.ok(errors.some((error) => error.includes('sensitive field')));
  assert.ok(errors.some((error) => error.includes('operator_required')));

  assert.equal(census.rows.length, census.rowCount);
  assert.equal(catalog.coverage.censusDerivation.includes('never derived from commands'), true);
  const verification = await verifyMutationCensus({ root: ROOT, manifest, catalog });
  assert.deepEqual(verification.errors, []);
  assert.equal(verification.counts.extracted, manifest.rows.length);
  for (const row of census.rows.filter(
    (entry) => entry.disposition === 'required_hosted_v1_mutation'
  )) {
    const sourceMethod = row.id === 'CrossTeamAPI.send' ? 'crossTeam.send' : row.sourceMethod;
    const mapped = catalog.commands.filter((command) =>
      command.sourceMethods.includes(sourceMethod)
    );
    assert.equal(mapped.length, 1, `census method must map exactly once: ${row.id}`);
    assert.equal(mapped[0].commandKind, row.commandKind);
    assert.equal(mapped[0].featureOwner, row.owner);
  }
  const omittedRowFixture = await json(resolve(TEST_DIR, 'fixtures/omitted-mutation-row.json'));
  const omittedRowManifest = clone(manifest);
  omittedRowManifest.rows = omittedRowManifest.rows.filter(
    (row) => row.id !== omittedRowFixture.mutationId
  );
  const omittedRowResult = await verifyMutationCensus({
    root: ROOT,
    manifest: omittedRowManifest,
    catalog,
  });
  assert.ok(
    omittedRowResult.errors.includes(
      `source member missing disposition ${omittedRowFixture.mutationId}`
    )
  );
  const staleManifest = clone(manifest);
  staleManifest.rows.push({
    id: 'TeamsAPI.removedMutation',
    interfaceName: 'TeamsAPI',
    sourceMethod: 'removedMutation',
    sourceFile: 'src/shared/types/api.ts',
    disposition: 'query',
    owner: 'team-read',
  });
  const staleResult = await verifyMutationCensus({ root: ROOT, manifest: staleManifest, catalog });
  assert.ok(
    staleResult.errors.includes('stale disposition without source member TeamsAPI.removedMutation')
  );
  const omittedDescriptorFixture = await json(
    resolve(TEST_DIR, 'fixtures/omitted-command-descriptor.json')
  );
  const omittedDescriptorCatalog = clone(catalog);
  omittedDescriptorCatalog.commands = omittedDescriptorCatalog.commands.filter(
    (command) => command.commandKind !== omittedDescriptorFixture.commandKind
  );
  const omittedDescriptorResult = await verifyMutationCensus({
    root: ROOT,
    manifest,
    catalog: omittedDescriptorCatalog,
  });
  assert.ok(
    omittedDescriptorResult.errors.some((error) =>
      error.startsWith(`required mutation must map exactly once ${omittedRowFixture.mutationId}=`)
    )
  );
  for (const commandKind of ['team.launch', 'team.cancel_provisioning', 'team.stop']) {
    assert.equal(
      catalog.commands.find((command) => command.commandKind === commandKind)?.featureOwner,
      'team-lifecycle'
    );
  }
  assert.equal(
    manifest.rows.find(
      (row) => row.id === 'OpenCodeRuntimeControlApi.answerOpenCodeRuntimePermission'
    )?.disposition,
    'deferred'
  );
  assert.equal(
    catalog.commands.some((command) => command.commandKind === 'runtime.permission_answer'),
    false
  );
  assert.ok(
    catalog.commands
      .filter((command) => ['team-task-board', 'team-messaging'].includes(command.featureOwner))
      .flatMap((command) => command.effects)
      .filter((effect) => effect.recoveryClass !== 'transactional_local')
      .every(
        (effect) =>
          !effect.automaticRecoveryAdmitted &&
          effect.currentRecoveryDisposition === 'operator_required'
      )
  );
  assert.ok(
    catalog.commands
      .filter((command) => ['team-task-board', 'team-messaging'].includes(command.featureOwner))
      .flatMap((command) => command.effects)
      .filter((effect) => effect.candidateRecoveryClass === 'idempotent_by_operation_id')
      .every((effect) => effect.recoveryClass === 'non_reconcilable')
  );
});

test('external W1-to-W5 gate rejects primary command owner drift', async () => {
  const catalog = await json(resolve(EVIDENCE, 'command-catalog.json'));
  const manifest = await json(resolve(EVIDENCE, 'mutation-surface-manifest.json'));
  const w1Ledger = await json(W1_API_PARITY_LEDGER);
  const verification = verifyCrossLaneOwnerAgreement({ w1Ledger, manifest, catalog });
  assert.deepEqual(verification.errors, []);
  assert.deepEqual(verification.counts, {
    comparedRequiredW1W5Members: 49,
    missingW1Rows: 0,
    ownerMismatches: 0,
  });

  const expectedOwners = new Map([
    ['git.initialize_repository', 'workspace-registry'],
    ['git.create_initial_commit', 'workspace-registry'],
    ['member.restart', 'team-lifecycle'],
    ['member.skip_for_launch', 'team-lifecycle'],
  ]);
  for (const [commandKind, owner] of expectedOwners) {
    const command = catalog.commands.find((entry) => entry.commandKind === commandKind);
    assert.equal(command?.featureOwner, owner, `${commandKind} primary owner`);
    assert.equal(
      command?.effects.filter((effect) => effect.effectRole === 'coordinator_effect').length,
      1,
      `${commandKind} coordinator effect`
    );
    assert.equal(
      command?.effects.find((effect) => effect.effectRole === 'coordinator_effect')?.effectOwner,
      owner,
      `${commandKind} coordinator owner`
    );
  }
  for (const commandKind of ['member.restart', 'member.skip_for_launch']) {
    const command = catalog.commands.find((entry) => entry.commandKind === commandKind);
    assert.equal(
      command?.effects.find((effect) => effect.effectRole === 'secondary_effect')?.effectOwner,
      'team-runtime-control',
      `${commandKind} secondary runtime effect owner`
    );
  }

  const driftedW1Ledger = clone(w1Ledger);
  driftedW1Ledger.members.find(
    (member) => member.source === 'TeamsAPI' && member.sourceMember === 'restartMember'
  ).owningFeature = 'team-runtime-control';
  const drifted = verifyCrossLaneOwnerAgreement({
    w1Ledger: driftedW1Ledger,
    manifest,
    catalog,
  });
  assert.ok(
    drifted.errors.includes(
      'cross-lane command owner mismatch TeamsAPI.restartMember: W5 team-lifecycle != W1 team-runtime-control'
    )
  );
});

test('all machine evidence validates against the checked-in schemas', async () => {
  const evidenceSchema = await json(resolve(EVIDENCE, 'evidence.schema.json'));
  const indexSchema = await json(resolve(EVIDENCE, 'index.schema.json'));
  const censusSchema = await json(resolve(EVIDENCE, 'mutation-census.schema.json'));
  const index = await json(resolve(EVIDENCE, 'index.json'));
  validateAgainstSchema(index, indexSchema);
  assert.equal(new Set(index.evidence.map((entry) => entry.id)).size, 6);
  for (const entry of index.evidence) {
    const document = await json(resolve(EVIDENCE, entry.path));
    validateAgainstSchema(document, evidenceSchema);
    assert.equal(document.evidenceId, entry.id);
  }
  validateAgainstSchema(await json(resolve(EVIDENCE, 'mutation-census.json')), censusSchema);
});

test('goldens persist digests and versions without fixture keys or command bodies', async () => {
  const raw = await readFile(resolve(EVIDENCE, 'fingerprint-goldens.json'), 'utf8');
  const goldens = JSON.parse(raw);
  assert.equal(raw.includes('phase-0-w5-public-fixture-key'), false);
  assert.equal(goldens.assertions.fieldOrderEqual, true);
  assert.equal(goldens.assertions.changedIntentDiffers, true);
  assert.equal(goldens.assertions.omittedDefaultEqualsMaterialized, true);
  assert.equal(goldens.assertions.fingerprintVersionDiffers, true);
  assert.equal(goldens.assertions.retainedFingerprintV1StillComputable, true);
  assert.equal(goldens.assertions.immutableOracleMatch, true);
  assert.equal(goldens.immutableOracleVectorCount, goldens.cases.length);
  assert.equal(goldens.assertions.retainedSameIntentOutcome, 'same_intent');
  assert.equal(goldens.assertions.changedIntentReuseOutcome, 'idempotency_mismatch');
  for (const vector of goldens.cases) {
    assert.match(vector.digest, /^[a-f0-9]{64}$/);
    assert.ok(vector.keyVersion && vector.fingerprintVersion && vector.schemaVersion);
  }
});
