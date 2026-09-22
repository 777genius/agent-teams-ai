#!/usr/bin/env node
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const [storePath, externalPath, tracePath, recoveryClass, crashPause, mode] = process.argv.slice(2);

if (!storePath || !externalPath || !tracePath || !recoveryClass || !crashPause || !mode) {
  throw new Error('effect recovery worker requires store, external, trace, class, pause, and mode');
}

const load = (path) => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, 'utf8');
  renameSync(temporary, path);
};
const trace = (message) =>
  appendFileSync(tracePath, `${JSON.stringify({ pid: process.pid, mode, message })}\n`, 'utf8');

const record = load(storePath);
const external = load(externalPath);
const compensationSchedule = crashPause.includes('compensation');
let outcome = record.commandOutcome ?? 'running';

const persistRecord = () => save(storePath, record);
const persistExternal = () => save(externalPath, external);
const persist = (field, value) => {
  record[field] = value;
  persistRecord();
  trace(`persist:${field}=${value}`);
};
const checkpoint = (name) => {
  trace(`boundary:${name}`);
  if (mode !== 'attempt' || name !== crashPause) return;
  trace(`crash:${name}`);
  process.exit(86);
};
const invokeExternal = () => {
  external.externalCallAttempts += 1;
  if (external.externalOperationIds.includes('operation-1')) {
    trace('adapter_deduplicated:operation-1');
  } else {
    external.externalOperationIds.push('operation-1');
    external.externalEffects += 1;
    trace('external_effect:operation-1');
  }
  persistExternal();
};
const compensate = () => {
  external.compensationAttempts += 1;
  if (!external.compensationOperationIds.includes('compensation-1')) {
    external.compensationOperationIds.push('compensation-1');
    external.compensationEffects += 1;
    trace('compensation:compensation-1');
  } else {
    trace('adapter_deduplicated:compensation-1');
  }
  persistExternal();
  persist('compensationState', 'compensated');
  persist('state', 'compensated');
};
const publish = () => {
  external.publicationAttempts += 1;
  persistExternal();
  trace('publish:wakeup-for-durable-journal');
};
const commitCommand = (value = 'committed') => {
  if (recoveryClass === 'transactional_local' && external.externalEffects === 0) {
    external.externalEffects = 1;
    external.externalOperationIds.push('transaction-operation-1');
    persistExternal();
  }
  record.commandOutcome = value;
  record.journalCommitted = true;
  persistRecord();
  trace(`commit:command+outbox:${value}`);
};
const proveAttempt = () => {
  if (recoveryClass === 'transactional_local') {
    persist('evidenceDisposition', 'same_transaction');
    return 'safe_to_continue';
  }
  if (recoveryClass === 'non_reconcilable') {
    if (!record.callMayHaveStarted) return 'safe_to_continue';
    persist('state', 'ambiguous');
    persist('evidenceDisposition', 'unproved');
    persist('commandOutcome', 'operator_required');
    outcome = 'operator_required';
    return 'stop';
  }
  const exists = external.externalOperationIds.includes('operation-1');
  trace(
    `${recoveryClass === 'idempotent_by_operation_id' ? 'lookup:operation-1' : 'lookup:operation-bound-evidence'}:${exists ? 'succeeded' : 'absent'}`
  );
  if (!exists) invokeExternal();
  persist(
    'evidenceDisposition',
    recoveryClass === 'idempotent_by_operation_id'
      ? 'durable_operation_lookup'
      : 'operation_bound_unique_evidence'
  );
  persist('state', 'observed_succeeded');
  return 'safe_to_continue';
};

function executeFromStart() {
  checkpoint('before_attempting');
  persist('state', 'attempting');
  persist('callMayHaveStarted', false);
  checkpoint('after_attempting');
  persist('callMayHaveStarted', true);
  checkpoint('before_external_call');
  if (recoveryClass === 'transactional_local') {
    trace('stage:transactional_local_effect');
  } else {
    invokeExternal();
  }
  checkpoint('after_external_call');
  checkpoint('before_evidence_query');
  persist(
    'evidenceDisposition',
    recoveryClass === 'transactional_local'
      ? 'same_transaction'
      : recoveryClass === 'idempotent_by_operation_id'
        ? 'durable_operation_lookup'
        : recoveryClass === 'non_reconcilable'
          ? 'explicit_in_call_ack'
          : 'operation_bound_unique_evidence'
  );
  persist('state', 'observed_succeeded');
  checkpoint('after_evidence_query');
  completeAfterEvidence();
}

function completeAfterEvidence() {
  if (compensationSchedule) {
    if (record.state !== 'compensated') {
      persist('state', 'compensating');
      persist('compensationState', 'compensating');
      checkpoint('before_compensation');
      compensate();
      checkpoint('after_compensation');
    }
    if (!record.commandOutcome) commitCommand('compensated');
  } else {
    checkpoint('before_command_commit');
    if (!record.commandOutcome) commitCommand();
    checkpoint('after_command_commit');
  }
  completePublication();
}

function completePublication() {
  checkpoint('before_event_publication');
  publish();
  checkpoint('after_event_publication');
  outcome = record.commandOutcome ?? outcome;
}

function recover() {
  trace(`restart:load:${record.state}`);
  if (record.commandOutcome === 'operator_required') {
    outcome = 'operator_required';
    return;
  }
  if (record.commandOutcome) {
    completePublication();
    return;
  }
  if (record.state === 'not_started') {
    trace('recover:not_started:safe_to_begin');
    executeFromStart();
    return;
  }
  if (record.state === 'attempting') {
    if (proveAttempt() === 'stop') return;
    if (record.state === 'attempting') {
      if (recoveryClass !== 'transactional_local') {
        invokeExternal();
        if (recoveryClass === 'non_reconcilable') {
          persist('evidenceDisposition', 'explicit_in_call_ack');
        }
      }
      persist('state', 'observed_succeeded');
    }
    completeAfterEvidence();
    return;
  }
  if (record.state === 'observed_succeeded') {
    trace(`recover:observed_succeeded:${record.evidenceDisposition}`);
    completeAfterEvidence();
    return;
  }
  if (record.state === 'compensating') {
    trace('recover:compensating');
    compensate();
    if (!record.commandOutcome) commitCommand('compensated');
    completePublication();
    return;
  }
  if (record.state === 'compensated') {
    if (!record.commandOutcome) commitCommand('compensated');
    completePublication();
  }
}

trace('process:start');
if (mode === 'attempt') executeFromStart();
else if (mode === 'recovery') recover();
else throw new Error(`unknown effect recovery worker mode: ${mode}`);

writeFileSync(
  process.stdout.fd,
  `${JSON.stringify({ pid: process.pid, outcome: record.commandOutcome ?? outcome })}\n`,
  'utf8'
);
