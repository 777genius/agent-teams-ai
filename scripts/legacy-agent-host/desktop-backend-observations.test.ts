import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRendererBackendConnections } from './desktop-backend-observations.ts';

test('read-only discovery survives navigation during the actual IPC read, then reads the new context', async () => {
  let reads = 0;
  const cdp = { async evaluate(expression: string) {
    if (expression.startsWith('Boolean(')) return true;
    reads++;
    if (reads === 1) throw new Error('Execution context was destroyed.');
    return { state: 'ready', bindings: [{ handle: 'original-owner' }] };
  } };
  assert.deepEqual(await readRendererBackendConnections(cdp), { kind: 'pending', reason: 'context-replaced' });
  assert.deepEqual(await readRendererBackendConnections(cdp), { kind: 'read', value: { state: 'ready', bindings: [{ handle: 'original-owner' }] } });
  assert.equal(reads, 2);
});

test('unregistered initial discovery waits, but owner failures are never hidden as navigation', async () => {
  const cdp = (failure: string) => ({ async evaluate(expression: string) {
    if (expression.startsWith('Boolean(')) return true;
    throw new Error(failure);
  } });
  assert.deepEqual(await readRendererBackendConnections(cdp("No handler registered for 'agentBackend:connections'")), { kind: 'pending', reason: 'handler-not-ready' });
  await assert.rejects(readRendererBackendConnections(cdp('Owner read forbidden')), /Owner read forbidden/);
});
