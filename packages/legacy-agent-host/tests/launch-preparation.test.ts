import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeDigest as digest } from '../dist/runtime/identity.js';
import { createLaunchMemberActions } from '../dist/team-launch/memberActions.js';
import { createLiveRosterLaunch, liveRosterValidationRecord } from '../dist/team-launch/liveRosterMembership.js';
import { launchPreparationFingerprint } from '../dist/team-launch/launchPreparation.js';
import { validateLaunchRecord } from '../dist/team-launch/validateLaunchRecord.js';
import { validateRestoreJournal } from '../dist/team-launch/validateRestoreJournal.js';
import type { ExpectedLaunchMember, LaunchAttempt, TeamLaunchRecord } from '../dist/team-launch/contracts.js';
import type { MemberActionRecord } from '../dist/team-launch/memberActions.js';

const initial = (_member: ExpectedLaunchMember, attemptId: string): LaunchAttempt => ({
  attemptId, hostIncarnation: 'TEST-P1b-host', startedAtMs: 0, deadlineMs: 0, claimed: false,
  status: 'not-started', reason: 'not-started', nativeReady: false, contextApplied: false,
  everReady: false, usable: false, controlAvailable: false, noAllocation: false,
});
const actionFingerprint = (row: MemberActionRecord) => digest({
  input: row.input, actor: row.actor, noAllocation: row.noAllocation,
  sourceAttemptId: row.sourceAttemptId, source: row.source, selected: row.selected,
});
function fixture() {
  const member: ExpectedLaunchMember = {
    memberId: 'alice', binding: { backendId: 'TEST-backend', teamId: 'TEST-team',
      runId: 'TEST-run', memberId: 'alice', generation: 'original-1' },
    configurationDigest: digest({ model: 'TEST-selected', generation: 1 }),
    baseConfigurationDigest: digest('TEST-original-base'), contextDigest: digest('TEST-context'),
    configRevision: 'TEST-selected-config', runtimeGeneration: 1, skipped: false, timeoutMs: 1000,
  };
  const input = { commandId: 'TEST-prepared-start', sourceRosterRevision: digest('TEST-original-roster'),
    members: [{ memberId: member.memberId, configuration: { model: 'TEST-selected' },
      configurationDigest: member.configurationDigest!, baseConfigurationDigest: member.baseConfigurationDigest!,
      configRevision: member.configRevision! }] };
  let record: TeamLaunchRecord = {
    schemaVersion: 1, definition: { launchId: 'TEST-run', rosterRevision: digest('TEST-selected-roster'), members: [member] },
    fingerprint: '', startCommandId: input.commandId, startedAtMs: 1,
    preparation: { ...input, fingerprint: launchPreparationFingerprint(input) },
    members: [{ memberId: member.memberId, currentAttemptId: 'TEST-original-attempt',
      attempts: [{ ...initial(member, 'TEST-original-attempt'), claimed: true,
        status: 'ready', reason: 'context-applied', nativeReady: true, contextApplied: true,
        everReady: true, usable: true, controlAvailable: true }] }], retries: [],
  };
  const recalculate = () => {
    record.definition.rosterRevision = digest({ scope: record.definition.launchId, members: record.definition.members });
    record.fingerprint = digest(record.definition);
  };
  recalculate();
  const actions = createLaunchMemberActions({
    authorized: (_action, fn) => fn(), read: () => record,
    captureActor: () => ({ principalId: 'TEST-human', authorityRevision: 1 }),
    observe: () => ({ attached: false, nativeReady: false }),
    write: next => { record = next; }, initial,
  });
  const current = () => structuredClone(record.definition.members[0]!);
  let sequence = 0;
  const action = (kind: 'restart' | 'skip') => {
    const source = current(), commandId = `TEST-${kind}-${++sequence}`;
    const selected = structuredClone(source);
    if (kind === 'skip') selected.skipped = true;
    else {
      selected.binding = { ...source.binding!,
        generation: 'restart-' + digest({ commandId, sourceBinding: source.binding }) };
      selected.runtimeGeneration = source.runtimeGeneration! + 1;
      selected.configurationDigest = digest({ model: 'TEST-selected', generation: selected.runtimeGeneration });
      delete selected.restore;
    }
    const admitted = actions.prepare({ commandId, launchId: record.definition.launchId,
      rosterRevision: record.definition.rosterRevision, memberId: source.memberId,
      expectedGeneration: source.binding!.generation, action: kind }, selected);
    actions.request(commandId);
    if (admitted.record.noAllocation) actions.unallocated(commandId);
    else actions.closed(commandId, () => true);
    actions.publish(commandId);
  };
  const restore = () => {
    const source = current(), commandId = `TEST-restore-${++sequence}`;
    const reference = 'cp1-' + digest(commandId);
    const member: ExpectedLaunchMember = { ...source,
      binding: { ...source.binding!, generation: 'restore-' + digest(commandId) },
      runtimeGeneration: source.runtimeGeneration! + 1,
      configurationDigest: digest({ model: 'TEST-selected', generation: source.runtimeGeneration! + 1 }),
      restore: { commandId, reference, sourceBinding: source.binding! } };
    (record.restorations ??= []).push({ commandId,
      fingerprint: digest({ memberId: member.memberId, reference }), member });
    record.definition.members[0] = member;
    const history = record.members[0]!;
    history.currentAttemptId = 'restore-' + digest(commandId);
    history.attempts.push(initial(member, history.currentAttemptId));
    recalculate();
  };
  const liveSuccessor = () => {
    const source = current();
    const live = createLiveRosterLaunch({ authorized: fn => fn(), read: () => record,
      write: next => { record = next; }, initial });
    const intent = (commandId: string, kind: 'remove' | 'restore') => ({
      commandId, requestDigest: digest(commandId), originalFingerprint: digest('TEST-original'),
      authorityRevision: 1, principalId: 'TEST-human', launchId: record.definition.launchId,
      sourceCaptureDigest: digest('TEST-capture'), expectedRevision: record.definition.rosterRevision,
      hostIncarnation: 'TEST-P1b-host', cutoff: Date.now() + 90_000, kind, memberId: source.memberId,
      source: structuredClone(source), previous: structuredClone(source),
    });
    const remove = intent('TEST-live-remove', 'remove');
    live.begin(remove); live.publish(remove.commandId, digest('TEST-removed-roster'));
    const next = intent('TEST-live-restore', 'restore');
    live.begin(next); live.seed(next.commandId, { kind: 'TEST-seed' });
    const member: ExpectedLaunchMember = { ...source,
      binding: { ...source.binding!, generation: 'live-' + digest({
        commandId: next.commandId, requestDigest: next.requestDigest, previous: source.binding }) },
      runtimeGeneration: source.runtimeGeneration! + 1, skipped: false,
      configurationDigest: digest('TEST-fresh-base'), baseConfigurationDigest: digest('TEST-fresh-base'),
      contextDigest: digest('TEST-fresh-context'), configRevision: 'TEST-fresh-config' };
    delete member.restore;
    live.capture(next.commandId, { kind: 'TEST-capture' }, member);
    live.publish(next.commandId, digest('TEST-restored-roster'));
  };
  const validate = (value = record) =>
    validateLaunchRecord(liveRosterValidationRecord(value), value.fingerprint, value.members.length);
  validate();
  return { read: () => record, action, restore, liveSuccessor, validate, recalculate };
}

for (const sequence of [
  [], ['restart'], ['restart', 'restart'], ['restore', 'restart'],
  ['restart', 'restore'], ['restart', 'skip'], ['restore', 'restart', 'skip'],
] as const) test(`P1b prepared lineage remains valid through ${sequence.join(' then ') || 'the original selection'}`, () => {
  const f = fixture(), original = JSON.stringify(f.read().preparation);
  for (const step of sequence) step === 'restore' ? f.restore() : f.action(step);
  validateRestoreJournal(f.read());
  f.validate();
  const bytes = JSON.stringify(f.read());
  f.validate(JSON.parse(bytes) as TeamLaunchRecord);
  assert.equal(JSON.stringify(f.read()), bytes, 'validation and cold read preserve every journal byte');
  assert.equal(JSON.stringify(f.read().preparation), original, 'later generation never rewrites original options');
});

for (const skip of [false, true]) test(`P1b historical configured segment ${skip ? 'ending in Skip' : 'after Restart'} remains valid after live Remove and Restore`, () => {
  const f = fixture(), original = JSON.stringify(f.read().preparation);
  f.action('restart');
  if (skip) f.action('skip');
  f.liveSuccessor();
  validateRestoreJournal(f.read());
  const bytes = JSON.stringify(f.read());
  f.validate();
  f.validate(JSON.parse(bytes) as TeamLaunchRecord);
  assert.equal(JSON.stringify(f.read()), bytes);
  assert.equal(JSON.stringify(f.read().preparation), original);
});

test('P1b an exact original preparation cannot be borrowed through a missing or counterfeit predecessor', () => {
  for (const change of ['missing-edge', 'early-original-digest', 'unmatched-restore'] as const) {
    const f = fixture();
    f.action('restart'); f.action('restart');
    const record = f.read(), rows = record.memberActions!;
    if (change === 'missing-edge') rows.shift();
    else {
      const row = rows.at(-1)!;
      row.source.configurationDigest = change === 'early-original-digest'
        ? record.preparation!.members[0]!.configurationDigest : digest('TEST-foreign-configuration');
      if (change === 'unmatched-restore') row.source.restore = {
        commandId: 'TEST-unrecorded-restore', reference: 'cp1-' + digest('TEST-unrecorded'),
        sourceBinding: { ...row.source.binding!, generation: 'TEST-foreign-source' } };
      row.fingerprint = actionFingerprint(row);
    }
    validateRestoreJournal(record); // A coherent binding graph alone does not prove original option lineage.
    const bytes = JSON.stringify(record);
    assert.throws(() => f.validate(), { code: 'hold' }, change);
    assert.equal(JSON.stringify(record), bytes);
  }
});

test('P1b a fabricated restore at the original preparation root remains held even with its original digest', () => {
  const f = fixture();
  f.action('restart');
  const record = f.read(), original = record.memberActions![0]!;
  assert.equal(original.source.configurationDigest, record.preparation!.members[0]!.configurationDigest);
  original.source.restore = { commandId: 'TEST-unrecorded-root-restore',
    reference: 'cp1-' + digest('TEST-unrecorded-root'),
    sourceBinding: { ...original.source.binding!, generation: 'TEST-unrecorded-root-source' } };
  original.fingerprint = actionFingerprint(original);
  validateRestoreJournal(record);
  const bytes = JSON.stringify(record);
  assert.throws(() => f.validate(), { code: 'hold' });
  assert.equal(JSON.stringify(record), bytes);
});

test('P1b original foreign malformed and pending selection histories still fail the complete owning validator', () => {
  for (const change of ['base', 'revision', 'original-digest', 'foreign-member', 'pending',
    'branch', 'cycle', 'missing-skip-proof'] as const) {
    const f = fixture();
    f.action('restart'); f.action('restart');
    const record = f.read(), rows = record.memberActions!, prepared = record.preparation!;
    const last = rows.at(-1)!;
    if (change === 'base') prepared.members[0]!.baseConfigurationDigest = digest('TEST-foreign-base');
    if (change === 'revision') prepared.members[0]!.configRevision = 'TEST-foreign-config';
    if (change === 'original-digest') prepared.members[0]!.configurationDigest = digest('TEST-foreign-original');
    if (change === 'foreign-member') last.source.memberId = 'TEST-foreign-member';
    if (change === 'pending') last.phase = 'prepared';
    if (change === 'branch') rows.push(structuredClone(rows[0]!));
    if (change === 'cycle') last.source.binding = structuredClone(last.selected.binding);
    if (change === 'missing-skip-proof') record.definition.members[0]!.skipped = true;
    prepared.fingerprint = launchPreparationFingerprint(prepared);
    last.fingerprint = actionFingerprint(last);
    f.recalculate();
    const bytes = JSON.stringify(record);
    assert.throws(() => f.validate(), { code: 'hold' }, change);
    assert.equal(JSON.stringify(record), bytes);
  }
});
