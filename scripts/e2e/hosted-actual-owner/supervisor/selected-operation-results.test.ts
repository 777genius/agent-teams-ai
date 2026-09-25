import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveRuntimePermissionApprovalIdentity } from '../../../../src/features/team-runtime-control/contracts';
import { canonicalJson, sha256 } from './canonical';
import { allocationFixture } from './selected-native-admission.fixture';
import { decodeNativeAllocation, immutableAllocation, matchesProductObservation, nativeAllocationSha256,
  type NativeAllocationSelection } from './selected-operation-allocation';
import { RetainedProductObservationResults, type RetainedObservationData } from './selected-operation-results';

/** Synthetic data only: this adapter cannot be installed as permit authority. */
class FixtureResults extends RetainedProductObservationResults {
  protected readonly retainedIntegrationOrigin = 'root-admitted-operation-results' as const;
  constructor(readonly allocation: NativeAllocationSelection, readonly records: readonly RetainedObservationData[]) { super(); immutableAllocation(records); }
}
function laterResults(allocation: NativeAllocationSelection, slot: 'A' | 'B') {
  const entry = allocation.entries.find(e => e.id === `${slot}preview`)!;
  const body = entry.operation.body;
  assert(body && 'resultBinding' in body);
  // This effect and opaque preview arrive only AFTER the caller froze allocation.
  const effectRef = `effect:${sha256(`later-effect-${slot}`)}`, previewRef = `approval_preview_later_${slot}`;
  const identity = deriveRuntimePermissionApprovalIdentity({ teamId: body.teamId, runId: body.expectedRunId,
    requestId: entry.operation.binding.requestId, effectRef });
  const pending = { ...identity, effectRef, previewRef };
  const item = { teamId: identity.teamId, runId: identity.runId, approvalId: identity.approvalId,
    generation: identity.approvalGeneration, previewRef, category: 'command', summary: 'Later pending',
    requestedAtMs: 1, expiresAtMs: null };
  const page = { schemaVersion: 1, kind: 'approval_page', teamId: identity.teamId,
    items: [{ ...item, approvalId: `approval_${'f'.repeat(32)}`, previewRef: 'approval_preview_unrelated' }, item],
    nextCursor: null, truncated: false,
    budget: { itemLimit: 20, byteLimit: 10000, timeLimitMs: 100, usedItems: 2, usedBytes: 1000, elapsedMs: 1 } };
  const record = (id: string, kind: RetainedObservationData['kind'], sequence: number, payload: unknown): RetainedObservationData => {
    const source = allocation.entries.find(e => e.id === id)!;
    return { allocationSha256: nativeAllocationSha256(allocation), operationId: id, generation: source.generation,
      slot, routeId: source.routeId, routeDigest: source.routeDigest, origin: source.origin,
      sessionId: source.operation.binding.sessionId, requestId: source.operation.binding.requestId,
      teamId: body.teamId, runId: body.expectedRunId, sequence, current: true, kind, requestBody: source.operation.body, payload };
  };
  const records = [record(body.resultBinding.subjectOperationId, 'committed-pending', 1, pending),
    record(body.resultBinding.operationId, 'product-page', 2, page)];
  const request = { schemaVersion: 1, teamId: item.teamId, expectedRunId: item.runId,
    approvalId: item.approvalId, expectedGeneration: item.generation, previewRef: item.previewRef };
  return { entry, pending, page, records, request };
}
test('A and B preview resolve a named later pending identity from a many-item page without thawing allocation', () => {
  const allocation = allocationFixture(), before = canonicalJson(allocation), digest = nativeAllocationSha256(allocation);
  for (const slot of ['A', 'B'] as const) {
    const f = laterResults(allocation, slot), retained = new FixtureResults(allocation, f.records);
    const match = (body: unknown, records = f.records) => matchesProductObservation(f.entry, 'POST',
      f.entry.operation.path, body, new FixtureResults(allocation, records));
    assert(match(f.request));
    assert(!matchesProductObservation(f.entry, 'POST', f.entry.operation.path, f.request));
    assert.equal(Reflect.apply(matchesProductObservation, null, [f.entry, 'POST', f.entry.operation.path,
      f.request, { allocation, records: f.records }]), false);
    assert(!matchesProductObservation(f.entry, 'GET', f.entry.operation.path, f.request, retained));
    for (const patch of [{ teamId: `team_${'7'.repeat(32)}` }, { expectedRunId: `run_${'7'.repeat(32)}` },
      { approvalId: `approval_${'7'.repeat(32)}` }, { expectedGeneration: 'generation_stale' },
      { previewRef: 'approval_preview_changed' }, { extra: true }]) assert(!match({ ...f.request, ...patch }));
    for (const patch of [{ origin: 'private-preflight' }, { generation: 2 }, { slot: 'other' },
      { routeId: 'other' }, { routeDigest: '0'.repeat(64) }, { teamId: 'other' }, { runId: 'other' },
      { requestId: 'other' }, { sessionId: 'other' }, { allocationSha256: '0'.repeat(64) },
      { current: false }, { sequence: 0 }, { operationId: 'alias' }, { requestBody: { altered: true } }]) {
      for (const index of [0, 1]) assert(!match(f.request, f.records.map((r, i) => i === index ? { ...r, ...patch } : r)));
    }
    assert(!match(f.request, f.records.slice(1)));
    assert(!match(f.request, [...f.records, f.records[0]]));
    assert(!match(f.request, [...f.records, f.records[1]]));
    assert(!match(f.request, [f.records[0], { ...f.records[1], sequence: 1 }]));
    for (const patch of [{ effectRef: `effect:${'0'.repeat(64)}` }, { requestId: 'other' },
      { approvalGeneration: 'generation_stale' }, { previewRef: 'approval_preview_stale' }]) {
      assert(!match(f.request, [{ ...f.records[0], payload: { ...f.pending, ...patch } }, f.records[1]]));
    }
    for (const items of [[], [f.page.items[0]], [f.page.items[1], f.page.items[1]],
      [{ ...f.page.items[1], generation: 'generation_stale' }],
      [{ ...f.page.items[1], previewRef: null }],
      [{ ...f.page.items[1], teamId: `team_${'8'.repeat(32)}` }],
      [{ ...f.page.items[1], runId: `run_${'8'.repeat(32)}` }]]) {
      assert(!match(f.request, [f.records[0], { ...f.records[1], payload: { ...f.page, items,
        budget: { ...f.page.budget, usedItems: items.length } } }]));
    }
    // Exact literals remain supported once the actual values are known.
    const literal = decodeNativeAllocation({ ...allocation, entries: allocation.entries.map(e => e === f.entry
      ? { ...e, operation: { ...e.operation, body: f.request } } : e) }).entries.find(e => e.id === f.entry.id)!;
    assert(matchesProductObservation(literal, 'POST', literal.operation.path, f.request));
  }
  assert.equal(canonicalJson(allocation), before); assert.equal(nativeAllocationSha256(allocation), digest);
});
test('dependent body codec rejects aliases, missing selectors and broken DAG or immutable relationships', () => {
  const allocation = allocationFixture(), f = allocation.entries.find(e => e.id === 'Apreview')!;
  const body = f.operation.body; assert(body && 'resultBinding' in body);
  const reject = (entry: unknown) => assert.throws(() => decodeNativeAllocation({ ...allocation,
    entries: allocation.entries.map(e => e === f ? entry : e) }));
  for (const resultBinding of [{ ...body.resultBinding, field: 'first-pending' },
    { ...body.resultBinding, operationId: 'Aterminal' }, { ...body.resultBinding, subjectOperationId: 'Bpending' },
    { ...body.resultBinding, pointer: '/items/0' }, { ...body.resultBinding, kind: 'current-row' },
    { kind: 'approval-page-item', operationId: 'Apage', field: 'pending-preview' }]) {
    reject({ ...f, operation: { ...f.operation, body: { ...body, resultBinding } } });
  }
  reject({ ...f, dependencies: ['Apage'] });
  reject({ ...f, operation: { ...f.operation, binding: { ...f.operation.binding, requestId: 'other' } } });
  reject({ ...f, operation: { ...f.operation, body: { ...body, expectedRunId: `run_${'8'.repeat(32)}` } } });
  assert.throws(() => decodeNativeAllocation({ ...allocation, entries: [...allocation.entries, { ...f, id: 'preview-alias' }] }));
  const page = allocation.entries.find(e => e.id === 'Apage')!;
  // Different page query, same pending subject: aliases cannot allocate another preview.
  const alias = { ...page, id: 'page-alias', operation: { ...page.operation,
    body: { ...page.operation.body, limit: 10 } } };
  assert.throws(() => decodeNativeAllocation({ ...allocation, entries: [...allocation.entries, alias,
    { ...f, id: 'preview-alias', dependencies: ['pending', alias.id], operation: { ...f.operation,
      binding: { ...f.operation.binding, operationId: alias.id }, body: { ...body,
        resultBinding: { ...body.resultBinding, operationId: alias.id } } } }] }));
});
