import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { test } from 'node:test';
import { canonicalJson } from './canonical';
import { allocationFixture, nativeContractFixture } from './selected-native-admission.fixture';
import { decodeNativeAllocation, matchesProductObservation } from './selected-operation-allocation';
import { decodeNativeLaunchAdmission, nativeLaunchAdmissionSigningBytes, verifyNativeLaunchAdmission,
  NATIVE_LAUNCH_ADMISSION } from './selected-native-admission-contract';
import { assertSelectedLaunchPreflightBound, encodeSelectedLaunchPhase } from './selected-launch-phase';

type Mutable<T> = T extends string | number | boolean | null ? T : T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type MutableAllocation = Mutable<ReturnType<typeof allocationFixture>>;
function mutableAllocation(source: ReturnType<typeof allocationFixture>): MutableAllocation {
  return { ...source, starts: source.starts.map(s => ({ ...s })),
    generations: source.generations.map(g => ({ ...g, supplemental: { ...g.supplemental }, slots: g.slots.map(s => ({ ...s })) })),
    entries: source.entries.map(e => ({ ...e, dependencies: [...e.dependencies], operation: { ...e.operation,
      binding: { ...e.operation.binding }, body: e.operation.body && 'resultBinding' in e.operation.body
        ? { ...e.operation.body, resultBinding: { ...e.operation.body.resultBinding } }
        : e.operation.body ? { ...e.operation.body } : null } })),
    obligations: source.obligations.map(o => ({ ...o, operationIds: [...o.operationIds], requirements: [...o.requirements] })) };
}

test('strict paired v2 signing bytes include one NUL and canonical UTF8, no LF', () => {
  const f = nativeContractFixture();
  const expected = Buffer.concat([Buffer.from('agent-teams.owner-native-launch-admission/v2'), Buffer.from([0]),
    Buffer.from(canonicalJson(f.statement))]);
  assert.deepEqual(nativeLaunchAdmissionSigningBytes(f.statement), expected);
  const publicKey = f.launcher.publicKey.export({ format: 'jwk' }).x!;
  assert.deepEqual(verifyNativeLaunchAdmission(f.admission, publicKey, f.request.launch, f.request.sealed), f.admission);
  for (const bytes of [Buffer.from(canonicalJson(f.statement)), Buffer.concat([expected, Buffer.from('\n')]),
    Buffer.from(`agent-teams.owner-native-launch-admission/v1\0${canonicalJson(f.statement)}`)]) {
    const altered = { ...f.admission, signatureBase64url: sign(null, bytes, f.launcher.privateKey).toString('base64url') };
    assert.throws(() => verifyNativeLaunchAdmission(altered, publicKey, f.request.launch, f.request.sealed));
  }
  assert.throws(() => decodeNativeLaunchAdmission({ ...f.admission, statement: { ...f.statement, format: NATIVE_LAUNCH_ADMISSION.replace('/v2', '/v1') } }));
  assert.throws(() => decodeNativeLaunchAdmission({ ...f.admission, statement: { ...f.statement, scenario: { row: '02', routeId: 'x' } } }));
  assert.throws(() => decodeNativeLaunchAdmission({ ...f.admission, signatureBase64url: f.admission.signatureBase64url + '=' }));
});
test('immutable full allocation rejects singleton, ambiguity, bounds, cycle, missing obligation and B before gen4', () => {
  const original = allocationFixture(); assert(Object.isFrozen(original.entries[0].operation.binding));
  const mutate = (edit: (v: MutableAllocation) => void) => { const v = mutableAllocation(original); edit(v); assert.throws(() => decodeNativeAllocation(v)); };
  mutate(v => { Object.assign(v, { scenario: { row: '02', routeId: 'route-A' } }); });
  mutate(v => { v.generations[3].slots.pop(); });
  mutate(v => { v.entries.push({ ...v.entries[2], id: 'ambiguous', row: original.obligations[2].row }); });
  mutate(v => { v.entries[0].maximumUses = 256; });
  mutate(v => { v.entries[0].dependencies = ['Rretry']; });
  mutate(v => { v.entries[0].dependencies = Array(9).fill('pending'); });
  mutate(v => { Object.assign(v.entries[0].operation, { callback: 'arbitrary' }); });
  mutate(v => { Object.assign(v.entries[0], { origin: 'environment' }); });
  mutate(v => { v.entries[0].slot = 'B'; });
  mutate(v => { v.obligations.pop(); });
  mutate(v => { v.obligations[3].requirements.pop(); });
  mutate(v => { v.entries = [v.entries[0]]; });
  mutate(v => { v.entries[2].operation.path = '/arbitrary'; });
  mutate(v => { v.generations[3].slots[1].activationEndpoint = v.generations[3].slots[0].activationEndpoint; });
});
test('HSL1 carries the exact admission and preserves aggregate bound without activation inputs', () => {
  const f = nativeContractFixture();
  const frame = encodeSelectedLaunchPhase(f.request.launch, f.request.sealed, f.admission);
  assert.equal(frame.readUInt32BE(0), 0x48534c31); assert.equal(frame.readUInt32BE(4), frame.length - 8);
  assert.deepEqual(JSON.parse(frame.subarray(8).toString()).nativeAdmission, f.admission);
  assert.throws(() => encodeSelectedLaunchPhase({ ...f.request.launch, substituted: true }, f.request.sealed, f.admission));
  assert.throws(() => assertSelectedLaunchPreflightBound({ huge: 'x'.repeat(256 * 1024) }));
});

test('copied result selectors, changed route digests and incomplete negative coverage are refused', () => {
  const allocation = allocationFixture();
  const edit = (change: (value: MutableAllocation) => void) => {
    const value = mutableAllocation(allocation); change(value); assert.throws(() => decodeNativeAllocation(value));
  };
  edit(v => { v.entries[8].operation.binding = { kind: 'operation-result', operationId: 'Nallow',
    sessionId: 'session-A', requestId: 'retry', field: 'permission' }; });
  edit(v => { v.entries[0].routeDigest = '0'.repeat(64); });
  edit(v => { const i = v.entries.findIndex((e) => e.operation.negativeCase === 'product-http:csrf_rejected');
    const id = v.entries[i].id; v.entries.splice(i, 1);
    v.obligations.forEach((o) => { o.operationIds = o.operationIds.filter((x: string) => x !== id); }); });
});

test('real Product POST page and preview bodies match; GET, changed bodies and page/list aliases reject', () => {
  const allocation = allocationFixture();
  for (const id of ['Apage', 'Aterminal', 'Bpage']) {
    const entry = allocation.entries.find(e => e.id === id)!;
    assert(matchesProductObservation(entry, 'POST', entry.operation.path, entry.operation.body));
    assert(!matchesProductObservation(entry, 'GET', entry.operation.path, entry.operation.body));
    assert(!matchesProductObservation(entry, 'POST', entry.operation.path, { ...entry.operation.body, expectedRunId: `run_${'8'.repeat(32)}` }));
    assert(!matchesProductObservation(entry, 'POST', entry.operation.path, { ...entry.operation.body, unexpected: true }));
    assert.throws(() => decodeNativeAllocation({ ...allocation, entries: allocation.entries.map(e => e.id === id
      ? { ...e, operation: { ...e.operation, method: 'GET' } } : e) }));
  }
  const page = allocation.entries.find(e => e.id === 'Apage')!;
  assert.throws(() => decodeNativeAllocation({ ...allocation, entries: [...allocation.entries,
    { ...page, id: 'alias', operation: { ...page.operation, kind: 'product-list',
      binding: { kind: 'exact', sessionId: 'fictional-session', requestId: 'fictional-request' } } }] }));
});
