import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { prepareRuntimeInput, validatePreparedInput } from '../dist/runtime/inputPreparation.js';
import { deliveryFingerprint, runtimeDigest } from '../dist/runtime/identity.js';
import type { RuntimeInput, RuntimeSessionRecord } from '../dist/runtime/contracts.js';

const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-run',
  memberId: 'TEST-member', generation: 'TEST-generation' };
const config = { tenantId: 'TEST-backend', projectId: 'TEST-project', sessionId: 'TEST-session',
  generation: 1, configRevision: 'TEST-config', requiredCapabilities: [] };
const selected = { prefix: 'TEST original context\n', epochIds: ['a'.repeat(64)], teamProof: 'b'.repeat(64) };
const maximum = 8 * 1024 * 1024;
function input(content: string): RuntimeInput {
  const intent = { binding, inputId: 'TEST-input', deliveryId: 'TEST-input', messageId: 'TEST-message', content };
  return { intent, fingerprint: deliveryFingerprint(intent), operationRef: 'TEST-operation', phase: 'claimed' };
}

test('P1 a capable-provider preparation above 256 KiB survives the real store and cold read unchanged', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-input-preparation-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = input('界'.repeat(100_000));
  original.preparation = prepareRuntimeInput(binding, original, selected, maximum);
  const record: RuntimeSessionRecord = { schemaVersion: 1, binding, profileId: 'TEST-profile',
    hostIncarnation: 'TEST-host', config, openFingerprint: runtimeDigest({ profileId: 'TEST-profile', config }),
    phase: 'allocated', sealed: false, custody: 'owned', nativeReady: true, sessionRef: 'TEST-native',
    inputs: [original], interactions: [] };
  const before = runtimeDigest(record);
  new FileRuntimeStore(root).fenced(binding, tx => tx.put(record));
  const reopened = new FileRuntimeStore(root).fenced(binding, tx => tx.get());
  assert.equal(runtimeDigest(reopened), before);
  assert.deepEqual(reopened?.inputs[0]?.preparation, original.preparation);
  const changed = structuredClone(original);
  changed.preparation!.prefix += 'TEST changed';
  assert.throws(() => validatePreparedInput(binding, changed), { code: 'hold' });
});

test('P1 prepared input accepts the common exact byte boundary and refuses the next byte', () => {
  const original = input('x'.repeat(maximum - Buffer.byteLength(selected.prefix)));
  original.preparation = prepareRuntimeInput(binding, original, selected, maximum);
  assert.doesNotThrow(() => validatePreparedInput(binding, original));
  const overflow = input(original.intent.content + 'x');
  assert.throws(() => prepareRuntimeInput(binding, overflow, selected, maximum), { code: 'hold' });
});
