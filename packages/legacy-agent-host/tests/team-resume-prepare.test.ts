import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TeamLaunchOwner } from '../dist/team-launch/TeamLaunchOwner.js';
import { TeamLaunchError } from '../dist/team-launch/contracts.js';
import { emptySession } from '../dist/runtime/sessionState.js';
import type {
  ExpectedLaunchMember,
  TeamLaunchOptions,
  TeamLaunchRecord,
} from '../dist/team-launch/contracts.js';
import type { ResumePreparationRequest } from '../dist/team-launch/launchResume.js';

function fixture() {
  const members: ExpectedLaunchMember[] = ['TEST-a', 'TEST-b'].map((memberId) => ({
    memberId,
    binding: {
      backendId: 'TEST-backend',
      teamId: 'TEST-team',
      runId: 'TEST-run',
      memberId,
      generation: 'TEST-source',
    },
    configurationDigest: 'a'.repeat(64),
    contextDigest: 'b'.repeat(64),
    configRevision: 'TEST-config',
    timeoutMs: 1000,
    runtimeGeneration: 1,
    skipped: false,
  }));
  let saved: TeamLaunchRecord | undefined,
    writes = 0,
    deny = false;
  const options: TeamLaunchOptions = {
    definition: { launchId: 'TEST-launch', rosterRevision: 'TEST-roster', members },
    hostIncarnation: 'TEST-host',
    store: {
      fenced: (fn) => fn(),
      read<T>() {
        return saved && (structuredClone(saved) as T);
      },
      write(_path, value) {
        writes++;
        saved = structuredClone(value) as TeamLaunchRecord;
      },
    },
    authorized(_action, fn) {
      if (deny) throw new TeamLaunchError('forbidden', 'TEST-denied');
      return fn();
    },
    runtime: {
      read(memberId) {
        const record = emptySession(
          members.find((member) => member.memberId === memberId)!.binding!,
          'TEST-profile',
          'TEST-host'
        );
        record.phase = 'closed';
        return { record, attached: false, nativeReady: false };
      },
      async open() {
        assert.fail('prepare/read must not allocate');
      },
    },
  };
  const owner = new TeamLaunchOwner(options);
  const request: ResumePreparationRequest = {
    launchId: 'TEST-launch',
    rosterRevision: 'TEST-roster',
    resumeId: 'TEST-resume',
    members: members.map((member, index) => ({
      memberId: member.memberId,
      sourceGeneration: 'TEST-source',
      reference: `cp1-${String(index + 1).repeat(64)}`,
      commandId: `TEST-restore-${member.memberId}`,
    })),
  };
  return {
    owner,
    request,
    writes: () => writes,
    state: () => structuredClone(saved!),
    cold: () =>
      new TeamLaunchOwner({
        ...options,
        hostIncarnation: 'TEST-cold',
        definition: structuredClone(saved!.definition),
      }),
    deny: () => {
      deny = true;
    },
    select(index = 0) {
      const row = request.members[index]!,
        source = members[index]!;
      return owner.selectRestore(
        {
          commandId: row.commandId,
          member: {
            ...source,
            binding: { ...source.binding!, generation: 'TEST-selected' },
            runtimeGeneration: 2,
            configurationDigest: 'c'.repeat(64),
            baseConfigurationDigest: source.configurationDigest!,
            restore: {
              commandId: row.commandId,
              reference: row.reference,
              sourceBinding: source.binding!,
            },
          },
        },
        () => {}
      );
    },
  };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof TeamLaunchError && error.code === expected;

test('whole immutable map precedes all effects, safe prepare replay survives cold partial selection', () => {
  const f = fixture();
  let verified = 0;
  const prepared = f.owner.prepareResume(f.request, (members) => {
    verified += members.length;
  });
  assert.equal(verified, 2);
  assert.deepEqual(
    prepared.members.map((member) => member.requested),
    [false, false]
  );
  const writes = f.writes();
  assert.deepEqual(
    f
      .cold()
      .prepareResume(f.request, () => assert.fail('safe replay must not recheck newer defaults')),
    prepared
  );
  assert.equal(f.writes(), writes);
  f.owner.requestResumeMember(f.request.resumeId, f.request.members[0]!);
  assert.equal(f.owner.readRestorations().preparations[0]!.members[0]!.requested, true);
  f.select();
  const cold = f.cold(),
    recovered = cold.prepareResume(f.request, () =>
      assert.fail('partial replay cannot prepare again')
    );
  assert.deepEqual(
    recovered.members.map((member) => member.requested),
    [true, false]
  );
  assert.equal(cold.readRestorations().restorations[0]!.commandId, f.request.members[0]!.commandId);
  assert.throws(
    () => cold.requestResumeMember(f.request.resumeId, f.request.members[0]!),
    code('hold')
  );
  assert.throws(
    () => cold.prepareResume({ ...f.request, members: [...f.request.members].reverse() }, () => {}),
    code('conflict')
  );
});

test('all-member validation failure or partial/stale map leaves no prepared command publication', () => {
  const f = fixture(),
    initial = f.state(),
    writes = f.writes();
  assert.throws(
    () =>
      f.owner.prepareResume(f.request, () => {
        throw new TeamLaunchError('hold', 'TEST-second-checkpoint-missing');
      }),
    code('hold')
  );
  for (const request of [
    { ...f.request, members: f.request.members.slice(0, 1) },
    { ...f.request, rosterRevision: 'TEST-stale' },
    { ...f.request, members: [f.request.members[0], f.request.members[0]] },
    {
      ...f.request,
      members: f.request.members.map((row) => ({ ...row, sourceGeneration: 'TEST-wrong' })),
    },
  ])
    assert.throws(() => f.owner.prepareResume(request, () => {}), code('conflict'));
  assert.equal(f.writes(), writes);
  assert.deepEqual(f.state(), initial);
  f.deny();
  assert.throws(
    () => f.owner.prepareResume(f.request, () => assert.fail('unauthorized checkpoint read')),
    code('forbidden')
  );
});

test('exact mapping and durable requested marker prevent omitted identity and native redispatch after reload', () => {
  const f = fixture();
  f.owner.prepareResume(f.request, () => {});
  const member = f.request.members[0]!;
  assert.throws(
    () => f.owner.requestResumeMember(undefined, { ...member, commandId: 'TEST-bypass' }),
    code('invalid')
  );
  assert.throws(
    () =>
      f.owner.requestResumeMember(f.request.resumeId, {
        ...member,
        reference: `cp1-${'f'.repeat(64)}`,
      }),
    code('conflict')
  );
  f.owner.requestResumeMember(f.request.resumeId, member);
  const recovered = f.cold();
  assert.equal(recovered.readRestorations().restorations.length, 0);
  assert.deepEqual(
    recovered.readRestorations().preparations[0]!.members.map((row) => row.requested),
    [true, false]
  );
  assert.throws(() => recovered.requestResumeMember(f.request.resumeId, member), code('hold'));
  assert.throws(
    () =>
      recovered.prepareResume(
        {
          ...f.request,
          resumeId: 'TEST-new',
          members: f.request.members.map((row) => ({ ...row, commandId: `new-${row.commandId}` })),
        },
        () => {}
      ),
    code('hold')
  );
});

test('known preselection refusal persists only with no-allocation proof; uncertain or selected requests stay held', () => {
  const f = fixture();
  f.owner.prepareResume(f.request, () => {});
  const member = f.request.members[0]!;
  f.owner.requestResumeMember(f.request.resumeId, member);
  const refusal = {
    resumeId: f.request.resumeId,
    commandId: member.commandId,
    code: 'hold' as const,
  };
  f.owner.refuseResumeMember(refusal, () => false);
  assert.equal(f.cold().readRestorations().preparations[0]!.members[0]!.refused, undefined);
  f.owner.refuseResumeMember(refusal, () => true);
  assert.equal(f.cold().readRestorations().preparations[0]!.members[0]!.refused, 'hold');
  assert.throws(() => f.owner.requestResumeMember(f.request.resumeId, member), code('hold'));
  const selected = fixture();
  selected.owner.prepareResume(selected.request, () => {});
  selected.owner.requestResumeMember(selected.request.resumeId, selected.request.members[0]!);
  selected.select();
  selected.owner.refuseResumeMember(
    {
      ...refusal,
      resumeId: selected.request.resumeId,
      commandId: selected.request.members[0]!.commandId,
    },
    () => true
  );
  assert.equal(selected.cold().readRestorations().preparations[0]!.members[0]!.refused, undefined);
});

test('composition records normalized refusal only after released-source proof and no selected native intent', async () => {
  const { settleLaunchResumeRefusal } = await import('../dist/composition/prepareLaunchResume.js');
  const { RuntimeOwnerError } = await import('../dist/runtime/contracts.js');
  const f = fixture();
  f.owner.prepareResume(f.request, () => {});
  const choice = f.request.members[0]!;
  f.owner.requestResumeMember(f.request.resumeId, choice);
  const binding = f.state().definition.members[0]!.binding!;
  const entry = { binding } as import('../dist/composition/MemberEntry.js').MemberEntry;
  const record = emptySession(binding, 'TEST-profile', 'TEST-host');
  record.phase = 'closed';
  const request = {
    resumeId: f.request.resumeId,
    commandId: choice.commandId,
    sourceGeneration: choice.sourceGeneration,
  };
  const unknown = { readSession: () => ({ record, attached: true }) };
  settleLaunchResumeRefusal(entry, unknown, f.owner, request, new RuntimeOwnerError('hold'));
  assert.equal(f.cold().readRestorations().preparations[0]!.members[0]!.refused, undefined);
  const released = { readSession: () => ({ record, attached: false }) };
  settleLaunchResumeRefusal(
    entry,
    released,
    f.owner,
    request,
    new Error('unqualified native exception')
  );
  assert.equal(f.cold().readRestorations().preparations[0]!.members[0]!.refused, undefined);
  settleLaunchResumeRefusal(entry, released, f.owner, request, new RuntimeOwnerError('hold'));
  assert.equal(f.cold().readRestorations().preparations[0]!.members[0]!.refused, 'hold');
});
