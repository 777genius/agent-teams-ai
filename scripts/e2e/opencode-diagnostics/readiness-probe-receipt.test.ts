import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  projectReadinessProbeReceipt,
  readReadinessProbeReceipts,
} from './readiness-probe-receipt.ts';

const sourceKey = 'a'.repeat(64),
  nonce = 'b'.repeat(32),
  model = 'openrouter/TEST-model';
const binding = {
  teamId: `TEST-execution-probe-${nonce}`,
  runId: nonce,
  controllerInstanceId: '11111111-1111-4111-8111-111111111111',
  ownerId: '22222222-2222-4222-8222-222222222222',
};
const probe = {
  sourceKey,
  binding,
  sessionID: 'ses_TEST',
  submitted: true,
  retired: true,
  proof: null,
  failure: 'native_execution_failed',
  intent: { text: 'DO_NOT_COPY_SECRET' },
};
const state = {
  binding,
  state: 'stopped',
  members: [
    {
      memberId: 'probe',
      originalSessionId: 'ses_TEST',
      selectedModel: model,
      profileRoot: 'DO_NOT_COPY_SECRET',
    },
  ],
};
const stop = {
  binding,
  receipt: {
    state: 'stopped',
    members: [
      {
        memberId: 'probe',
        cleanup: {
          scopeClosed: true,
          processRetired: true,
          descendantsRetired: true,
          secret: 'DO_NOT_COPY_SECRET',
        },
      },
    ],
  },
};

test('original readiness failure remains distinct from team bootstrap and team cleanup', () => {
  const receipt = projectReadinessProbeReceipt(sourceKey, probe, state, stop, model)!;
  assert.equal(receipt.classification, 'readiness_native_terminal_failed');
  assert.equal(receipt.submitted, true);
  assert.equal(receipt.retired, true);
  assert.equal(receipt.authority, 'observation_only');
  assert.equal(receipt.providerFailure, 'not_preserved_in_probe_record');
  assert.deepEqual(receipt.cleanup, {
    scopeClosed: true,
    processRetired: true,
    descendantsRetired: true,
  });
  assert(!JSON.stringify(receipt).includes('DO_NOT_COPY_SECRET'));
  assert(!JSON.stringify(receipt).includes('ses_TEST'));
  assert.equal(receipt.ownerProviderWire, null);
});

test('foreign source, run, session, member, model or inconsistent submitted failure cannot qualify', () => {
  for (const changed of [
    { sourceKey: 'c'.repeat(64) },
    { submitted: false },
    { proof: { arbitrary: 'secret' } },
    { binding: { ...binding, teamId: 'test-user-team' } },
    { sessionID: 'ses_OTHER' },
    { failure: 'provider.auth SECRET' },
  ])
    assert.equal(
      projectReadinessProbeReceipt(sourceKey, { ...probe, ...changed }, state, stop, model),
      null
    );
  for (const changed of [
    { binding: { ...binding, ownerId: '33333333-3333-4333-8333-333333333333' } },
    { members: [{ ...state.members[0], selectedModel: 'other/model' }] },
    { members: [{ ...state.members[0], memberId: 'alice' }] },
  ])
    assert.equal(
      projectReadinessProbeReceipt(sourceKey, probe, { ...state, ...changed }, stop, model),
      null
    );
  const foreignStop = {
    ...stop,
    binding: { ...binding, ownerId: '33333333-3333-4333-8333-333333333333' },
  };
  const receipt = projectReadinessProbeReceipt(sourceKey, probe, state, foreignStop, model)!;
  assert.equal(receipt.stopState, null);
  assert.deepEqual(receipt.cleanup, {
    scopeClosed: false,
    processRetired: false,
    descendantsRetired: false,
  });
});

test('owner initialization wire status is closed and never labeled as external inference', () => {
  const ownerProbe = {
    ...probe,
    submitted: false,
    failure: 'native_owner_retired',
    ownerFailure: {
      category: 'DO_NOT_COPY_SECRET',
      operation: {
        operation: 'model-read',
        stage: 'response',
        status: 403,
        body: 'DO_NOT_COPY_SECRET',
      },
    },
  };
  const receipt = projectReadinessProbeReceipt(sourceKey, ownerProbe, state, stop, model)!;
  assert.equal(receipt.classification, 'readiness_owner_not_submitted');
  assert.deepEqual(receipt.ownerProviderWire, {
    operation: 'model-read',
    stage: 'response',
    httpStatus: 403,
  });
  assert(!JSON.stringify(receipt).includes('DO_NOT_COPY_SECRET'));
  assert.equal(
    projectReadinessProbeReceipt(sourceKey, { ...ownerProbe, retired: false }, state, stop, model),
    null
  );
});

test('disk capture reads the separate probe binding and refuses a symlinked namespace', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-oc-probe-receipt-')));
  const dataRoot = path.join(root, 'runtime-data');
  const probeRoot = path.join(dataRoot, 'opencode/v2/execution-probes');
  const probeDir = path.join(probeRoot, sourceKey);
  const runKey = createHash('sha256')
    .update(JSON.stringify({ runId: binding.runId, teamId: binding.teamId }))
    .digest('hex')
    .slice(0, 32);
  const runDir = path.join(dataRoot, 'opencode/v2/runs', runKey);
  try {
    await mkdir(probeDir, { recursive: true });
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(probeDir, 'probe.json'), JSON.stringify(probe));
    await writeFile(path.join(runDir, 'state.json'), JSON.stringify(state));
    await writeFile(path.join(runDir, 'stop.json'), JSON.stringify(stop));
    const capture = await readReadinessProbeReceipts(root, dataRoot, model);
    assert.equal(capture.observation, 'read');
    assert.equal(capture.candidates, 1);
    assert.equal(capture.receipts[0]?.classification, 'readiness_native_terminal_failed');
    assert.equal(capture.unmatchedOrUnavailable, 0);
    const foreign = await readReadinessProbeReceipts(root, dataRoot, 'different/model');
    assert.equal(foreign.unmatchedOrUnavailable, 1);
    assert.deepEqual(foreign.receipts, []);
    await rm(probeRoot, { recursive: true });
    await symlink(path.join(dataRoot, 'opencode/v2/runs'), probeRoot, 'junction');
    assert.equal(
      (await readReadinessProbeReceipts(root, dataRoot, model)).observation,
      'unavailable'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
