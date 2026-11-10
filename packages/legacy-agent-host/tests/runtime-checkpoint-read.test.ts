import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CheckpointCoordinator } from '../dist/runtime/CheckpointCoordinator.js';
import {
  checkpointFingerprint,
  checkpointPayloadDigest,
} from '../dist/runtime/checkpointIdentity.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { emptySession, historyDigest } from '../dist/runtime/sessionState.js';
import { RuntimeOwnerError } from '../dist/runtime/contracts.js';
import type {
  CheckpointCoordinatorOptions,
  CheckpointPayload,
} from '../dist/runtime/checkpointContracts.js';
import type { RuntimeSessionRecord } from '../dist/runtime/contracts.js';

function fixture() {
  const binding = {
    backendId: 'TEST-backend',
    teamId: 'TEST-team',
    runId: 'TEST-run',
    memberId: 'TEST-lead',
    generation: 'TEST-source',
  };
  const config = {
    tenantId: 'TEST-tenant',
    projectId: 'TEST-project',
    sessionId: 'TEST-private-session',
    generation: 1,
    configRevision: 'TEST-private-config',
    requiredCapabilities: ['tools'],
  };
  const record = emptySession(binding, 'TEST-profile', 'TEST-old-host');
  Object.assign(record, {
    config,
    phase: 'closed',
    custody: 'released',
    sessionRef: 'TEST-native-private',
    sealed: true,
  });
  const checkpointId = 'TEST-checkpoint',
    reference = `cp1-${runtimeDigest({ binding, checkpointId })}`;
  const body: Omit<CheckpointPayload, 'digest'> = {
    schemaVersion: 1,
    reference,
    checkpointId,
    fingerprint: checkpointFingerprint(binding, 'TEST-profile', config, checkpointId),
    sourceBinding: binding,
    profileId: 'TEST-profile',
    sourceConfig: structuredClone(config),
    sourceSessionRef: 'TEST-native-private',
    historyDigest: historyDigest(record),
    completedOperations: [],
    opaque: { nativePath: '/TEST/MISSING/native-backing', token: 'TEST-private-token' },
  };
  let payload: CheckpointPayload = { ...body, digest: checkpointPayloadDigest(body) };
  record.checkpoints = [
    {
      checkpointId,
      reference,
      fingerprint: body.fingerprint,
      hostIncarnation: 'TEST-old-host',
      status: 'published',
      historyDigest: body.historyDigest,
      payloadDigest: payload.digest,
    },
  ];
  let records: RuntimeSessionRecord[] = [record],
    reads = 0,
    authorized = true,
    missing = false;
  const options: CheckpointCoordinatorOptions = {
    profileId: 'TEST-profile',
    hostIncarnation: 'TEST-new-host',
    authorize: () => authorized,
    driver() {
      assert.fail('read must never access native driver');
    },
    store: {
      fenced(_binding, action) {
        return action({
          get: () => records[0],
          siblings: () => records,
          put() {
            assert.fail('read must never write runtime state');
          },
        });
      },
    },
    storage: {
      readCheckpointPayload() {
        reads++;
        if (missing) throw new Error('/PRIVATE/MISSING');
        return structuredClone(payload);
      },
      writeCheckpoint() {
        assert.fail('read must never publish checkpoint');
      },
    },
  };
  return {
    binding,
    config,
    record,
    options,
    read: () =>
      new CheckpointCoordinator(options).readAvailable(binding, { ...config, generation: 2 }),
    missing: () => {
      missing = true;
    },
    corrupt: () => {
      payload.opaque = { token: 'TEST-corrupt' };
    },
    cold: () => {
      records = JSON.parse(JSON.stringify(records)) as RuntimeSessionRecord[];
      payload = JSON.parse(JSON.stringify(payload)) as CheckpointPayload;
    },
    addSibling: (change: Partial<RuntimeSessionRecord>) =>
      records.push({
        ...structuredClone(record),
        binding: { ...binding, generation: 'TEST-sibling' },
        ...change,
      }),
    forbid: () => {
      authorized = false;
    },
    reads: () => reads,
    clear: () => {
      records = [];
    },
  };
}

test('cold read lists exact published refs without native access/writes and keeps backing explicitly unverified', () => {
  const f = fixture();
  f.cold();
  const result = f.read();
  assert.equal(result.sourceGeneration, 'TEST-source');
  assert.equal(result.status, 'owner-eligible');
  assert.equal(result.reason, 'native-backing-unverified');
  assert.equal(result.nativeBacking, 'unverified');
  assert.equal(result.checkpoints.length, 1);
  assert.equal(result.checkpoints[0]!.checkpointId, 'TEST-checkpoint');
  assert.match(result.checkpoints[0]!.reference, /^cp1-[a-f0-9]{64}$/);
  assert.equal(result.checkpoints[0]!.status, 'owner-eligible');
  for (const secret of [
    'nativePath',
    'TEST-private-token',
    'TEST-private-session',
    'TEST-native-private',
  ])
    assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(f.reads(), 1);
});

test('missing/corrupt private payload never offers eligible history or private error text', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.missing(),
    (f: ReturnType<typeof fixture>) => f.corrupt(),
  ]) {
    const f = fixture();
    mutate(f);
    const result = f.read();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'payload-unavailable');
    assert.equal(result.checkpoints[0]!.status, 'unavailable');
    assert.equal(JSON.stringify(result).includes('/PRIVATE'), false);
  }
});

test('custody, later uncertain input, changed config/profile and sibling debt refuse owner eligibility', () => {
  const cases: [string, (f: ReturnType<typeof fixture>) => void][] = [
    [
      'custody-unreleased',
      (f) => {
        f.record.custody = 'unknown';
      },
    ],
    [
      'history-changed',
      (f) => {
          f.record.control = { inputId: 'TEST-input', operationRef: 'TEST-operation', phase: 'unknown' };
      },
    ],
    [
      'configuration-changed',
      (f) => {
        f.config.configRevision = 'TEST-changed';
      },
    ],
    [
      'configuration-changed',
      (f) => {
        f.options.profileId = 'TEST-other-profile';
      },
    ],
    [
      'sibling-unreleased',
      (f) => {
        f.addSibling({ custody: 'unknown' });
      },
    ],
    [
      'generation-conflict',
      (f) => {
        f.addSibling({ config: { ...f.config, generation: 2 } });
      },
    ],
  ];
  for (const [reason, mutate] of cases) {
    const f = fixture();
    mutate(f);
    assert.equal(f.read().reason, reason, reason);
    assert.equal(f.read().status, 'unavailable', reason);
  }
});

test('unpublished/unsupported records and bounded malformed publications never become resumable', () => {
  const f = fixture();
  f.record.checkpoints = [];
  assert.equal(f.read().reason, 'checkpoint-unavailable');
  f.record.checkpoints = [
    { checkpointId: 'TEST-held', fingerprint: 'x', hostIncarnation: 'TEST-host', status: 'held' },
  ];
  assert.deepEqual(f.read().checkpoints, []);
  f.record.checkpoints[0]!.status = 'unsupported';
  assert.equal(f.read().reason, 'unsupported');
  const bounded = fixture();
  bounded.record.checkpoints = Array.from({ length: 129 }, () =>
    structuredClone(bounded.record.checkpoints![0]!)
  );
  assert.equal(bounded.read().reason, 'checkpoint-budget');
  assert.equal(bounded.reads(), 0);
  const malformed = fixture();
  malformed.record.checkpoints![0]!.reference = '/TEST/private-file';
  assert.equal(malformed.read().reason, 'checkpoint-invalid');
  assert.deepEqual(malformed.read().checkpoints, []);
  f.clear();
  assert.equal(f.read().reason, 'source-unavailable');
  const { storage: _storage, ...unsupported } = fixture().options;
  assert.equal(
    new CheckpointCoordinator(unsupported).readAvailable(f.binding, { ...f.config, generation: 2 })
      .reason,
    'unsupported'
  );
});

test('read requires current authority before inspecting private payloads', () => {
  const f = fixture();
  f.forbid();
  assert.throws(
    f.read,
    (error) => error instanceof RuntimeOwnerError && error.code === 'forbidden'
  );
  assert.equal(f.reads(), 0);
});
