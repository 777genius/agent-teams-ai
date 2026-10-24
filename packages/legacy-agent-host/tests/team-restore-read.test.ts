import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TeamLaunchOwner } from '../dist/team-launch/TeamLaunchOwner.js';
import { TeamLaunchError } from '../dist/team-launch/contracts.js';
import { readLaunchRestorations } from '../dist/composition/readLaunchRestorations.js';
import { emptySession } from '../dist/runtime/sessionState.js';
import type {
  ExpectedLaunchMember,
  TeamLaunchOptions,
  TeamLaunchRecord,
} from '../dist/team-launch/contracts.js';
import type { RuntimeBinding } from '../dist/runtime/contracts.js';

function fixture() {
  const binding: RuntimeBinding = {
    backendId: 'TEST-backend',
    teamId: 'TEST-team',
    runId: 'TEST-run',
    memberId: 'TEST-member',
    generation: 'TEST-original',
  };
  const source: ExpectedLaunchMember = {
    memberId: binding.memberId,
    binding,
    configurationDigest: 'a'.repeat(64),
    contextDigest: 'b'.repeat(64),
    configRevision: 'TEST-private-config',
    timeoutMs: 1000,
    runtimeGeneration: 1,
    skipped: false,
  };
  let saved: TeamLaunchRecord | undefined,
    writes = 0,
    forbidden = false;
  const options: TeamLaunchOptions = {
    definition: { launchId: 'TEST-launch', rosterRevision: 'TEST-roster', members: [source] },
    hostIncarnation: 'TEST-old-host',
    store: {
      fenced: (fn) => fn(),
      read<T>() {
        return saved ? (structuredClone(saved) as T) : undefined;
      },
      write(_path, value) {
        writes++;
        saved = structuredClone(value) as TeamLaunchRecord;
      },
    },
    authorized(_action, fn) {
      if (forbidden) throw new TeamLaunchError('forbidden', 'TEST-authority');
      return fn();
    },
    runtime: {
      read() {
        const record = emptySession(binding, 'TEST-profile', 'TEST-host');
        record.phase = 'closed';
        return { record, attached: false, nativeReady: false };
      },
      async open() {
        assert.fail('read must never allocate');
      },
    },
  };
  const owner = new TeamLaunchOwner(options);
  const select = (commandId: string, prior = source, generation = 2) => {
    const reference = `cp1-${String(generation).repeat(64)}`;
    return owner.selectRestore(
      {
        commandId,
        member: {
          ...prior,
          binding: { ...binding, generation: `TEST-selected-${generation}` },
          runtimeGeneration: generation,
          configurationDigest: 'c'.repeat(64),
          baseConfigurationDigest: source.configurationDigest!,
          restore: { commandId, reference, sourceBinding: prior.binding! },
        },
      },
      () => {}
    );
  };
  return {
    owner,
    select,
    writes: () => writes,
    forbid: () => {
      forbidden = true;
    },
    cold() {
      return new TeamLaunchOwner({
        ...options,
        hostIncarnation: 'TEST-cold-host',
        definition: structuredClone(saved!.definition),
      });
    },
    corrupt() {
      saved!.restorations = Array(65).fill(saved!.restorations![0]);
    },
    state: () => structuredClone(saved!),
  };
}

test('original restore selection is queryable before allocation and after cold reopen without writes', () => {
  const f = fixture();
  assert.deepEqual(f.owner.readRestorations().restorations, []);
  f.select('TEST-command');
  const before = f.state(),
    writes = f.writes();
  const result = readLaunchRestorations(f.cold(), {
    readSession: () => ({ record: undefined, attached: false }),
  });
  assert.equal(result.launchId, 'TEST-launch');
  assert.equal(result.rosterRevision, before.definition.rosterRevision);
  assert.deepEqual(result.restorations, [
    {
      commandId: 'TEST-command',
      memberId: 'TEST-member',
      reference: `cp1-${'2'.repeat(64)}`,
      sourceGeneration: 'TEST-original',
      selectedGeneration: 'TEST-selected-2',
      current: true,
      phase: 'unopened',
      custody: 'released',
      attached: false,
    },
  ]);
  assert.equal(f.writes(), writes);
  assert.deepEqual(f.state(), before);
  assert.equal(JSON.stringify(result).includes('TEST-private-config'), false);
});

test('older original commands remain visible and exact Runtime read failure stays unknown', () => {
  const f = fixture(),
    first = f.select('TEST-first');
  f.select('TEST-second', first, 3);
  const seen: RuntimeBinding[] = [];
  const result = readLaunchRestorations(f.owner, {
    readSession(binding) {
      seen.push(binding);
      if (binding.generation === 'TEST-selected-2') throw new Error('/TEST/private-error');
      const record = emptySession(binding, 'TEST-profile', 'TEST-host');
      record.phase = 'closed';
      return { record, attached: false };
    },
  });
  assert.deepEqual(
    seen.map((row) => row.generation),
    ['TEST-selected-2', 'TEST-selected-3']
  );
  assert.deepEqual(
    result.restorations.map((row) => [row.commandId, row.current, row.phase, row.custody]),
    [
      ['TEST-first', false, 'unavailable', 'unknown'],
      ['TEST-second', true, 'closed', 'released'],
    ]
  );
  assert.equal(JSON.stringify(result).includes('/TEST/private-error'), false);
});

test('revoked reads and corrupt oversized journals refuse without hiding original entries', () => {
  const f = fixture();
  f.select('TEST-command');
  f.forbid();
  assert.throws(
    () => f.owner.readRestorations(),
    (error) => error instanceof TeamLaunchError && error.code === 'forbidden'
  );
  const corrupt = fixture();
  corrupt.select('TEST-command');
  corrupt.corrupt();
  assert.throws(
    () => corrupt.owner.readRestorations(),
    (error) => error instanceof TeamLaunchError && error.code === 'hold'
  );
});
