import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { launchPreparationFingerprint } from '../dist/team-launch/launchPreparation.js';
import { validateLaunchRecord } from '../dist/team-launch/validateLaunchRecord.js';
import type { MemberActionRecord } from '../src/team-launch/memberActions.ts';
import type { ExpectedLaunchMember, TeamLaunchRecord } from '../src/team-launch/contracts.ts';

const d = runtimeDigest;
const binding = {
  backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-launch',
  memberId: 'TEST-member', generation: 'TEST-original',
};
const recipe = { provider: 'TEST-provider', generation: 1 };
const preparedDigest = d(recipe);
const baseDigest = d({ base: 'TEST-selected-base' });
const source: ExpectedLaunchMember = {
  memberId: binding.memberId, binding, skipped: false, timeoutMs: 10_000,
  runtimeGeneration: 1, configRevision: 'TEST-revision',
  configurationDigest: preparedDigest, baseConfigurationDigest: baseDigest,
  contextDigest: d({ context: 'TEST' }),
};
const actor = { principalId: 'TEST-human', authorityRevision: 1 };
function action(
  commandId: string, original: ExpectedLaunchMember,
  selected: ExpectedLaunchMember, kind: 'restart' | 'skip'
): MemberActionRecord {
  const input = {
    commandId, launchId: binding.runId, rosterRevision: 'TEST-original-roster',
    memberId: binding.memberId, expectedGeneration: original.binding!.generation,
    action: kind,
  };
  const record = {
    input, actor, noAllocation: false, sourceAttemptId: 'TEST-attempt-' + commandId,
    source: original, selected,
  };
  return { ...record, fingerprint: d(record), phase: 'selected' };
}
function makeRecord(includeSkip: boolean): TeamLaunchRecord {
  const restarted: ExpectedLaunchMember = {
    ...source, binding: {
      ...binding,
      generation: 'restart-' + d({ commandId: 'TEST-restart', sourceBinding: binding }),
    },
    runtimeGeneration: 2, configurationDigest: d({ ...recipe, generation: 2 }),
  };
  const restart = action('TEST-restart', source, restarted, 'restart');
  const skip = action('TEST-skip', restarted, { ...restarted, skipped: true }, 'skip');
  const definition = {
    launchId: binding.runId, rosterRevision: 'TEST-current-roster',
    members: [includeSkip ? skip.selected : restart.selected],
  };
  const preparationInput = {
    commandId: 'TEST-launch', sourceRosterRevision: 'TEST-original-roster',
    members: [{
      memberId: binding.memberId, configuration: { model: 'TEST-configured-model' },
      configurationDigest: preparedDigest, baseConfigurationDigest: baseDigest,
      configRevision: 'TEST-revision',
    }],
  };
  return {
    schemaVersion: 1,
    definition,
    fingerprint: d(definition),
    preparation: { ...preparationInput, fingerprint: launchPreparationFingerprint(preparationInput) },
    memberActions: includeSkip ? [restart, skip] : [restart],
    members: [{
      memberId: binding.memberId,
      currentAttemptId: 'TEST-current-attempt',
      attempts: [{
        attemptId: 'TEST-current-attempt', hostIncarnation: 'TEST-host',
        startedAtMs: 0, deadlineMs: 10_000, claimed: false,
        status: 'not-started', reason: 'pending',
        nativeReady: false, contextApplied: false, everReady: false,
        usable: false, controlAvailable: false, noAllocation: true,
      }],
    }],
    retries: [],
  };
}
function checked(record: TeamLaunchRecord) {
  record.fingerprint = d(record.definition);
  validateLaunchRecord(record, record.fingerprint, 1);
}
function changed<T>(value: T): T { return structuredClone(value); }

test('configured Restart and Restart-then-Skip preserve original preparation through full journal validation', () => {
  for (const skipped of [false, true]) {
    const record = makeRecord(skipped), before = JSON.stringify(record.preparation);
    assert.doesNotThrow(() => checked(record));
    assert.equal(JSON.stringify(record.preparation), before);
    assert.notEqual(record.definition.members[0]!.configurationDigest, preparedDigest);
  }
});

test('prepared Restart cannot borrow another digest, source, generation or unresolved action', () => {
  for (const mutate of [
    (r: TeamLaunchRecord) => {
      r.memberActions![0]!.source.configurationDigest = d('TEST-forged-origin');
      const row = r.memberActions![0]!;
      row.fingerprint = d({
        input: row.input, actor: row.actor, noAllocation: row.noAllocation,
        sourceAttemptId: row.sourceAttemptId, source: row.source, selected: row.selected,
      });
    },
    (r: TeamLaunchRecord) => { r.memberActions![0]!.phase = 'requested'; },
    (r: TeamLaunchRecord) => { r.definition.members[0]!.configurationDigest = d('TEST-injected'); },
    (r: TeamLaunchRecord) => { r.definition.members[0]!.configRevision = 'TEST-replacement'; },
    (r: TeamLaunchRecord) => { r.memberActions = []; },
  ]) {
    const record = changed(makeRecord(false));
    mutate(record);
    assert.throws(() => checked(record), /Team launch hold/);
  }
});

test('a forged Skip and changed prepared bytes cannot authorize the original launch', () => {
  const forged = makeRecord(true);
  forged.definition.members[0]!.skipped = false;
  assert.throws(() => checked(forged), /Team launch hold/);
  const changedPreparation = makeRecord(false);
  changedPreparation.preparation!.members[0]!.configurationDigest = d('TEST-forged-preparation');
  assert.throws(() => checked(changedPreparation), /Team launch hold/);
});
