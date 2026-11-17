import assert from 'node:assert/strict';
import { test } from 'node:test';
import { desktopProcessOwnerExpression, readDesktopProcessData } from './desktop-native-process-ui.ts';

const selection = 'TEST-owner', id = 'TEST-process';
const original = { id, processRef: 'TEST-original-ref', observation: 'same-live', canTerminate: true };
const stopped = { id, processRef: 'TEST-stopped-ref', observation: 'absent', stoppedAt: '2026-10-29T00:00:00Z', canTerminate: false };
function observe(candidates: Record<string, unknown>[], reference: string | null) {
  const fibers = candidates.map(process => ({ memoizedProps: { teamName: selection, processes: [process] }, alternate: null, return: null }));
  const node = { __reactFiber$test: { ...fibers[0], alternate: fibers[1], return: fibers[2] }, querySelectorAll: () => [] };
  return Function('document', 'return ' + desktopProcessOwnerExpression(selection, id, reference))({ querySelector: () => node });
}
const wireOriginal = { ...original, pid: 123, label: 'TEST original', registeredAt: '2026-10-29T00:00:00Z',
  processRef: 'p1:TEST-process:' + 'a'.repeat(64) };
const wireStopped = { ...wireOriginal, observation: 'absent', canTerminate: false, stoppedAt: stopped.stoppedAt };
const wireNeighbor = { ...wireOriginal, id: 'TEST-neighbor', pid: 456, processRef: 'p1:TEST-neighbor:' + 'b'.repeat(64) };
function packedReadFixture(processes: unknown[] = [wireOriginal]) {
  const binding = { handle: { handleId: 'TEST-packed-owner' }, label: 'TEST owner',
    ownerResourceRef: 'a'.repeat(64), teamResourceRef: '00000000-0000-5000-8000-000000000001',
    members: [{ memberId: 'TEST-member', label: 'TEST member' }] };
  const snapshot = { state: 'ready', bindings: [binding] };
  const state = { before: structuredClone(snapshot), after: structuredClone(snapshot),
    reply: { ok: true, value: processes } as unknown, connections: 0, ids: 0 };
  const requests: unknown[] = [];
  const window = { electronAPI: { agentBackend: {
    getConnections: async () => structuredClone(++state.connections === 1 ? state.before : state.after),
    invoke: async (request: unknown) => { requests.push(request); return state.reply; },
  } } };
  const location = { href: 'file:///TEST/resources/app.asar/out/renderer/index.html' };
  return { state, requests, selection: 'host-team:TEST-packed-owner',
    packed: { rendererUrl: location.href, bindingJson: JSON.stringify(binding) },
    cdp: { evaluate: async (expression: string): Promise<unknown> =>
      Function('window', 'location', 'crypto', 'return ' + expression)(
        window, location, { randomUUID: () => 'TEST-read-' + ++state.ids }) },
  };
}
test('post-Stop observer continues past stale original and pending alternate to fresh stopped props', () => {
  const pending = { ...stopped, pendingStop: { native: 'accepted' } };
  assert.deepEqual(observe([original, pending, stopped], null)?.process, stopped);
  assert.equal(observe([original, pending, { ...stopped, observation: 'unknown' }], null), null);
  return (async () => {
    const captured = packedReadFixture([wireStopped, wireNeighbor]);
    assert.deepEqual(await readDesktopProcessData(captured.cdp, captured.selection, captured.packed),
      { processes: [wireStopped, wireNeighbor], readRoute: 'packaged-public-process-list' });
    assert.equal(captured.state.connections, 2);
    assert.deepEqual(captured.requests, [{ handle: { handleId: 'TEST-packed-owner' },
      commandId: 'TEST-read-1', operation: 'process.list', payload: {} }]);
    const sourceData = { teamName: captured.selection, processes: [wireOriginal, wireNeighbor] };
    const expressions: string[] = [];
    assert.equal(await readDesktopProcessData({ evaluate: async expression => {
      expressions.push(expression); return sourceData;
    } }, captured.selection), sourceData);
    assert.deepEqual(expressions, [
      '(async()=>{const {api}=await import(\'/api/index.ts\');return await api.teams.getData("host-team:TEST-packed-owner");})()',
    ]);
  })();
});
test('initial original-ref observation remains exact and cannot select a replacement ref', () => {
  assert.deepEqual(observe([stopped, original], original.processRef)?.process, original);
  assert.equal(observe([stopped], original.processRef), null);
  return (async () => {
    for (const refusal of ['foreign', 'ambiguous']) {
      const captured = packedReadFixture();
      if (refusal === 'foreign') captured.state.before.bindings[0]!.ownerResourceRef = 'f'.repeat(64);
      else captured.state.before.bindings.push(structuredClone(captured.state.before.bindings[0]!));
      await assert.rejects(readDesktopProcessData(captured.cdp, captured.selection, captured.packed), /binding changed/);
      assert.equal(captured.requests.length, 0);
      assert.equal(captured.state.connections, 1);
    }
    const changed = packedReadFixture();
    changed.state.after.bindings[0]!.ownerResourceRef = 'f'.repeat(64);
    await assert.rejects(readDesktopProcessData(changed.cdp, changed.selection, changed.packed), /binding changed/);
    assert.equal(changed.requests.length, 1);
    assert.equal(changed.state.connections, 2);
    const refused = packedReadFixture();
    refused.state.reply = { ok: false, code: 'hold', outcome: 'unknown' };
    await assert.rejects(readDesktopProcessData(refused.cdp, refused.selection, refused.packed), /read refused/);
    assert.equal(refused.requests.length, 1);
    const duplicate = packedReadFixture([wireOriginal, { ...wireOriginal }]);
    await assert.rejects(readDesktopProcessData(duplicate.cdp, duplicate.selection, duplicate.packed), /Duplicate process identity/);
    assert.equal(duplicate.requests.length, 1);
  })();
});
