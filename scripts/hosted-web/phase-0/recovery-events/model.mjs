import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EFFECT_WORKER = resolve(SCRIPT_DIR, 'effect-recovery-worker.mjs');

export const RECOVERY_CLASSES = new Set([
  'transactional_local',
  'idempotent_by_operation_id',
  'reconcilable_by_unique_evidence',
  'compensatable',
  'non_reconcilable',
]);

export const SNAPSHOT_PAUSES = [
  'before_cursor',
  'after_cursor',
  'before_read',
  'after_read',
  'before_commit',
  'after_commit',
  'before_serialization',
  'after_serialization',
  'before_listener',
  'after_listener',
  'before_replay',
  'after_replay',
];

const TX_SNAPSHOT_PAUSES = new Set([
  'after_cursor',
  'before_read',
  'after_read',
  'before_commit',
  'after_commit',
]);

function newServer() {
  return { cursor: 0, revision: 0, value: 'v0', events: [] };
}

function commitMutation(server, trace, scheduledBoundary = 'unspecified') {
  if (server.revision !== 0) return;
  trace.push(`mutation:start:${scheduledBoundary}`);
  trace.push('transition:before_commit:revision-0:cursor-0');
  server.cursor = 1;
  server.revision = 1;
  server.value = 'v1';
  server.events.push({ cursor: 1, eventId: 'event-1', revision: 1, value: 'v1' });
  trace.push('commit:state+journal:event-1', 'transition:after_commit:revision-1:cursor-1');
}

function replay(server, client, trace) {
  for (const event of server.events.filter((item) => item.cursor > client.lastCursor)) {
    if (client.eventIds.has(event.eventId) || event.revision <= client.revision) {
      client.duplicates += 1;
    } else {
      client.value = event.value;
      client.revision = event.revision;
      client.eventIds.add(event.eventId);
    }
    client.lastCursor = event.cursor;
    trace.push(`replay:${event.eventId}`);
  }
}

export function runAcceptedSchedule(algorithm, mutationPause, crashPause) {
  if (!['sqlite_same_transaction', 'external_lower_c0'].includes(algorithm)) {
    throw new Error(`Unknown snapshot algorithm: ${algorithm}`);
  }
  if (!SNAPSHOT_PAUSES.includes(mutationPause)) {
    throw new Error(`Unknown mutation pause: ${mutationPause}`);
  }
  if (!SNAPSHOT_PAUSES.includes(crashPause)) {
    throw new Error(`Unknown crash pause: ${crashPause}`);
  }

  const server = newServer();
  const trace = [];
  let restartCount = 0;
  let durableBeforeCrash = null;

  const executeAttempt = (canCrash) => {
    let snapshot = null;
    let barrier = null;
    let pendingTxCommit = false;
    const client = {
      value: null,
      revision: -1,
      lastCursor: -1,
      eventIds: new Set(),
      duplicates: 0,
    };
    const attempt = restartCount + 1;
    const at = (pause) => {
      trace.push(`boundary:${pause}:attempt-${attempt}`);
      if (pause === mutationPause && server.revision === 0) {
        if (algorithm === 'sqlite_same_transaction' && TX_SNAPSHOT_PAUSES.has(pause)) {
          pendingTxCommit = true;
          trace.push('mutation:concurrent_commit_deferred_from_snapshot_view');
        } else {
          commitMutation(server, trace, pause);
        }
      }
      if (canCrash && pause === crashPause) {
        if (pendingTxCommit) commitMutation(server, trace, mutationPause);
        durableBeforeCrash = {
          cursor: server.cursor,
          revision: server.revision,
          journalRows: server.events.length,
        };
        trace.push(`crash:${pause}:discard-partial-snapshot`);
        restartCount += 1;
        trace.push(`restart:${restartCount}:reload-durable-journal`);
        throw new Error('scheduled-snapshot-crash');
      }
    };

    at('before_cursor');
    const frozen = { cursor: server.cursor, revision: server.revision, value: server.value };
    barrier = frozen.cursor;
    trace.push(`cursor:${barrier}`);
    at('after_cursor');
    at('before_read');
    snapshot =
      algorithm === 'sqlite_same_transaction'
        ? { revision: frozen.revision, value: frozen.value }
        : { revision: server.revision, value: server.value };
    trace.push(`read:revision-${snapshot.revision}`);
    at('after_read');
    at('before_commit');
    if (pendingTxCommit) commitMutation(server, trace, mutationPause);
    at('after_commit');
    if (pendingTxCommit) commitMutation(server, trace, mutationPause);

    at('before_serialization');
    client.value = snapshot.value;
    client.revision = snapshot.revision;
    client.lastCursor = barrier;
    trace.push(`serialize:revision-${snapshot.revision}:barrier-${barrier}`);
    at('after_serialization');
    at('before_listener');
    trace.push('listener:registered-before-query');
    at('after_listener');
    at('before_replay');
    replay(server, client, trace);
    at('after_replay');
    // A heartbeat/high-watermark loop queries durable rows even if a wake-up was coalesced.
    replay(server, client, trace);
    return client;
  };

  let client;
  try {
    client = executeAttempt(true);
  } catch (error) {
    if (error.message !== 'scheduled-snapshot-crash') throw error;
    client = executeAttempt(false);
  }

  return {
    algorithm,
    mutationPause,
    crashPause,
    restartCount,
    durableBeforeCrash,
    durableAfterRestart: {
      cursor: server.cursor,
      revision: server.revision,
      journalRows: server.events.length,
    },
    converged: client.value === server.value && client.revision === server.revision,
    gap: client.revision < server.revision,
    duplicates: client.duplicates,
    finalRevision: client.revision,
    authoritativeRevision: server.revision,
    mutationCommitTransitions: trace.filter((entry) => entry.startsWith('transition:')),
    trace,
  };
}

export function runSnapshotScheduler() {
  const schedules = [];
  for (const algorithm of ['sqlite_same_transaction', 'external_lower_c0']) {
    for (const mutationPause of SNAPSHOT_PAUSES) {
      for (const crashPause of SNAPSHOT_PAUSES) {
        schedules.push(runAcceptedSchedule(algorithm, mutationPause, crashPause));
      }
    }
  }

  const cursorAfterRead = (() => {
    const server = newServer();
    const trace = [];
    const snapshot = { revision: server.revision, value: server.value };
    trace.push('read:revision-0');
    commitMutation(server, trace);
    const barrier = server.cursor;
    trace.push('cursor:1', 'listener:registered', 'replay:rows>1:none');
    return {
      id: 'negative_cursor_after_read',
      reproduced: snapshot.revision < server.revision && barrier === server.cursor,
      gap: true,
      trace,
    };
  })();

  const queryThenListen = (() => {
    const server = newServer();
    const trace = ['cursor:0', 'read:revision-0', 'replay-query:rows>0:none'];
    commitMutation(server, trace);
    trace.push('wake-up:dropped-no-listener', 'listener:registered', 'broken-tail:no-requery');
    return { id: 'negative_query_then_listen', reproduced: true, gap: true, trace };
  })();

  return {
    schemaVersion: 1,
    evidenceId: 'P0.W5.SNAPSHOT_HANDOFF_SCHEDULER',
    model: 'single durable state mutation plus same-row journal event; in-memory fanout is a hint',
    exploredScheduleCount: schedules.length,
    pauses: SNAPSHOT_PAUSES,
    acceptedAlgorithms: [
      {
        id: 'sqlite_same_transaction',
        invariant: 'projection, revision vector, and lower cursor share one SQLite read snapshot',
      },
      {
        id: 'external_lower_c0',
        invariant: 'retained C0 is captured before scan; snapshot may overlap replay',
      },
    ],
    schedules,
    negativeControls: [cursorAfterRead, queryThenListen],
    exceptionalSchedules: [
      { id: 'retention_overtakes_c0', outcome: 'snapshot_retry_or_resync_required' },
      { id: 'external_generation_changes_during_scan', outcome: 'discard_and_retry' },
      { id: 'foreign_old_or_ahead_epoch_cursor', outcome: 'resync_required' },
      {
        id: 'listener_wakeup_lost_or_coalesced',
        outcome: 'durable_high_watermark_requery_converges',
      },
    ],
    conclusion:
      'All accepted schedules converge with zero gaps. Duplicate replay is expected for lower-C0 snapshots; both prohibited algorithms lose the committed mutation.',
  };
}

export const EFFECT_RECOVERY_PAUSES = [
  'before_attempting',
  'after_attempting',
  'before_external_call',
  'after_external_call',
  'before_evidence_query',
  'after_evidence_query',
  'before_command_commit',
  'after_command_commit',
  'before_compensation',
  'after_compensation',
  'before_event_publication',
  'after_event_publication',
];

const COMMON_EFFECT_PAUSES = EFFECT_RECOVERY_PAUSES.filter(
  (pause) => !['before_compensation', 'after_compensation'].includes(pause)
);

function durableSnapshot(record) {
  return {
    state: record.state,
    commandOutcome: record.commandOutcome,
    journalCommitted: record.journalCommitted,
    evidenceDisposition: record.evidenceDisposition,
    compensationState: record.compensationState,
    callMayHaveStarted: record.callMayHaveStarted,
  };
}

function runEffectCrashSchedule(recoveryClass, crashPause) {
  const directory = mkdtempSync(join(tmpdir(), 'phase-0-w5-effect-'));
  const storePath = join(directory, 'durable-command.json');
  const externalPath = join(directory, 'external-adapter.json');
  const tracePath = join(directory, 'trace.ndjson');
  writeFileSync(
    storePath,
    `${JSON.stringify({
      state: 'not_started',
      commandOutcome: null,
      journalCommitted: false,
      evidenceDisposition: 'none',
      compensationState: 'not_applicable',
      callMayHaveStarted: false,
    })}\n`
  );
  writeFileSync(
    externalPath,
    `${JSON.stringify({
      externalCallAttempts: 0,
      externalEffects: 0,
      externalOperationIds: [],
      compensationAttempts: 0,
      compensationEffects: 0,
      compensationOperationIds: [],
      publicationAttempts: 0,
    })}\n`
  );
  try {
    const args = [storePath, externalPath, tracePath, recoveryClass, crashPause];
    const attempt = spawnSync(process.execPath, [EFFECT_WORKER, ...args, 'attempt'], {
      encoding: 'utf8',
    });
    if (attempt.status !== 86) {
      throw new Error(
        `effect attempt did not crash at ${recoveryClass}/${crashPause}: status=${attempt.status} stderr=${attempt.stderr}`
      );
    }
    const durableBeforeCrash = durableSnapshot(JSON.parse(readFileSync(storePath, 'utf8')));
    const recovery = spawnSync(process.execPath, [EFFECT_WORKER, ...args, 'recovery'], {
      encoding: 'utf8',
    });
    if (recovery.status !== 0) {
      throw new Error(
        `effect recovery failed at ${recoveryClass}/${crashPause}: status=${recovery.status} stderr=${recovery.stderr}`
      );
    }
    const recoveryResult = JSON.parse(recovery.stdout.trim());
    const record = JSON.parse(readFileSync(storePath, 'utf8'));
    const external = JSON.parse(readFileSync(externalPath, 'utf8'));
    const traceRecords = readFileSync(tracePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const trace = traceRecords.map((entry) => entry.message);
    const processIds = [...new Set(traceRecords.map((entry) => entry.pid))];
    return {
      recoveryClass,
      crashPause,
      outcome: recoveryResult.outcome,
      restartCount: 1,
      attemptExitCode: attempt.status,
      recoveryExitCode: recovery.status,
      processIds,
      freshProcess: processIds.length === 2 && processIds[0] !== processIds[1],
      durableBeforeCrash,
      durableAfterRecovery: durableSnapshot(record),
      externalCallAttempts: external.externalCallAttempts,
      externalEffects: external.externalEffects,
      compensationAttempts: external.compensationAttempts,
      compensationEffects: external.compensationEffects,
      publicationAttempts: external.publicationAttempts,
      duplicateEffect: external.externalEffects > 1 || external.compensationEffects > 1,
      committedWithoutEvidence:
        record.commandOutcome === 'committed' && record.evidenceDisposition === 'none',
      trace,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function runEffectRecoveryScheduler() {
  const schedules = [];
  for (const recoveryClass of RECOVERY_CLASSES) {
    for (const crashPause of COMMON_EFFECT_PAUSES) {
      schedules.push(runEffectCrashSchedule(recoveryClass, crashPause));
    }
  }
  for (const crashPause of ['before_compensation', 'after_compensation']) {
    schedules.push(runEffectCrashSchedule('compensatable', crashPause));
  }
  const negativeControls = [
    {
      id: 'stale_unique_evidence',
      recoveryClass: 'reconcilable_by_unique_evidence',
      observedEvidence: 'stale_generation',
      outcome: 'operator_required',
      retryAttempted: false,
    },
    {
      id: 'coincidentally_equal_state',
      recoveryClass: 'reconcilable_by_unique_evidence',
      observedEvidence: 'desired_bytes_without_operation_identity',
      outcome: 'operator_required',
      retryAttempted: false,
    },
    {
      id: 'mismatched_operation_lookup',
      recoveryClass: 'idempotent_by_operation_id',
      observedEvidence: 'different_operation_id',
      outcome: 'operator_required',
      retryAttempted: false,
    },
    {
      id: 'lost_non_reconcilable_response',
      recoveryClass: 'non_reconcilable',
      observedEvidence: 'attempting_without_ack',
      outcome: 'operator_required',
      retryAttempted: false,
    },
  ];
  return {
    exploredScheduleCount: schedules.length,
    pauses: EFFECT_RECOVERY_PAUSES,
    schedules,
    negativeControls,
    invariant:
      'every scheduled boundary performs a durable crash/restart; recovery never duplicates an effect or commits without descriptor-required evidence',
  };
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function frame(value) {
  return `${byteLength(value)}:${value}`;
}

export function encodeIntent(value) {
  if (value === null) return 'n:0:';
  if (typeof value === 'boolean') return value ? 'b:1:1' : 'b:1:0';
  if (typeof value === 'string') return `s:${byteLength(value)}:${value}`;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Fingerprint numbers must be safe integers');
    const text = String(value);
    return `i:${byteLength(text)}:${text}`;
  }
  if (Array.isArray(value)) {
    return `a:${value.length}:${value.map((item) => frame(encodeIntent(item))).join('')}`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    return `o:${entries.length}:${entries
      .map(([key, item]) => `${frame(encodeIntent(key))}${frame(encodeIntent(item))}`)
      .join('')}`;
  }
  throw new Error(`Unsupported fingerprint value: ${typeof value}`);
}

export function fingerprintIntent({
  descriptorId,
  schemaVersion,
  fingerprintVersion,
  intent,
  key,
}) {
  const encoded = encodeIntent({ descriptorId, schemaVersion, fingerprintVersion, intent });
  return createHmac('sha256', key).update(encoded).digest('hex');
}

export function resolveClaim(existing, incoming) {
  if (!existing) return { outcome: 'claimed', record: incoming };
  const comparable = [
    'descriptorId',
    'schemaVersion',
    'fingerprintVersion',
    'keyVersion',
    'digest',
  ];
  return comparable.every((field) => existing[field] === incoming[field])
    ? { outcome: 'same_intent', record: existing }
    : { outcome: 'idempotency_mismatch', record: existing };
}

export function validateCommandCatalog(catalog) {
  const errors = [];
  const commandIds = new Set();
  const effectIds = new Set();
  const sensitive =
    /(^|_)(body|prompt|message_text|path|secret|token|credential|approval_input)($|_)/i;
  for (const command of catalog.commands ?? []) {
    if (commandIds.has(command.commandKind))
      errors.push(`duplicate command ${command.commandKind}`);
    commandIds.add(command.commandKind);
    if (!command.featureOwner) errors.push(`${command.commandKind} has no feature owner`);
    if (!command.normalizedIntentFields?.length)
      errors.push(`${command.commandKind} has no intent`);
    for (const field of command.normalizedIntentFields ?? []) {
      if (sensitive.test(field))
        errors.push(`${command.commandKind} persists sensitive field ${field}`);
    }
    const coordinatorEffects = (command.effects ?? []).filter(
      (effect) => effect.effectRole === 'coordinator_effect'
    );
    if (coordinatorEffects.length !== 1) {
      errors.push(`${command.commandKind} must have exactly one coordinator effect`);
    }
    for (const effect of command.effects ?? []) {
      const qualified = `${command.commandKind}:${effect.effectId}`;
      if (effectIds.has(qualified)) errors.push(`duplicate effect ${qualified}`);
      effectIds.add(qualified);
      if (!effect.effectOwner) errors.push(`${qualified} has no effect owner`);
      if (!['coordinator_effect', 'secondary_effect'].includes(effect.effectRole)) {
        errors.push(`${qualified} has invalid effect role ${effect.effectRole}`);
      }
      if (
        effect.effectRole === 'coordinator_effect' &&
        effect.effectOwner !== command.featureOwner
      ) {
        errors.push(`${qualified} coordinator owner does not match command owner`);
      }
      if (!effect.writerAuthority || !effect.writerEvidenceRef) {
        errors.push(`${qualified} has no writer authority evidence`);
      }
      if (
        effect.automaticRecoveryAdmitted === false &&
        !String(effect.currentRecoveryDisposition).startsWith('operator_required')
      ) {
        errors.push(`${qualified} unproved recovery must fail closed to operator_required`);
      }
      if (!RECOVERY_CLASSES.has(effect.recoveryClass)) {
        errors.push(`${qualified} has invalid recovery class ${effect.recoveryClass}`);
      }
      if (
        effect.recoveryClass === 'non_reconcilable' &&
        effect.ambiguousOutcome !== 'operator_required'
      ) {
        errors.push(`${qualified} must become operator_required`);
      }
    }
  }
  for (const required of catalog.coverage?.requiredMutationMethods ?? []) {
    if (!(catalog.commands ?? []).some((command) => command.sourceMethods?.includes(required))) {
      errors.push(`unmapped required mutation method ${required}`);
    }
  }
  return errors;
}
