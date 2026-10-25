import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';

import { readRendererBackendConnections } from './desktop-backend-observations.ts';
import { attachRendererDiagnostics } from './desktop-team-ui-smoke.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const ready = { originMatches: true, mainReady: true, errorPresent: false, phase: 'ready',
  uiDidInit: true, storePresent: true, rootChildCount: 1 };
function fixture(reads: ReturnType<typeof deferred<Record<string, unknown>>>[]) {
  const listeners = new Map<string, (value: unknown) => void>();
  const acknowledgments = reads.map(() => deferred<void>());
  let observations = 0, discovery = 0;
  const cdp = {
    on(method: string, listener: (value: unknown) => void) { listeners.set(method, listener); },
    async send(method: string) {
      if (method === 'Runtime.enable') listeners.get('Runtime.executionContextCreated')?.({
        context: { id: 7, auxData: { isDefault: true, frameId: 'TEST-frame' } },
      });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'TEST-frame', url: 'http://localhost:5173/' } } };
      if (method === 'Runtime.evaluate') return { result: { value: { url: 'http://localhost:5173/', readyState: 'complete' } } };
      return {};
    },
    async evaluate(expression: string) {
      if (expression.startsWith('Boolean(')) return true;
      if (expression === 'window.electronAPI.agentBackend.getConnections()') {
        discovery++; return { state: 'ready', bindings: [] };
      }
      assert.ok(expression.includes('window.electronAPI.startup.getStatus()'), 'only public startup snapshot before discovery');
      const index = observations++;
      assert.ok(reads[index], 'no extra startup read after its original deadline');
      acknowledgments[index]!.resolve();
      return reads[index]!.promise;
    },
  };
  const evidence: Record<string, unknown> = {};
  const start = (remainingMs: number) => attachRendererDiagnostics(cdp, 'http://localhost:5173/', evidence,
    { remainingMs, assertOwnedRenderer() {} }).then(() => readRendererBackendConnections(cdp));
  return { start, acknowledgments, evidence, discovery: () => discovery };
}

test('captured UI discovery waits for Main admission and actual mount while early diagnostics remain active', { timeout: 5000 }, async () => {
  const reads = [deferred<Record<string, unknown>>(), deferred<Record<string, unknown>>(), deferred<Record<string, unknown>>()];
  const f = fixture(reads), pending = f.start(3000);
  await Promise.race([f.acknowledgments[0]!.promise, pending.then(() => { assert.fail('discovery completed before Main/UI readiness was observed'); })]);
  assert.equal(f.discovery(), 0);
  const diagnostics = f.evidence.rendererDiagnostics as { startup: { status: string }; };
  assert.equal(diagnostics.startup.status, 'DOCUMENT_READY', 'document diagnostics do not wait for full app admission');
  reads[0]!.resolve({ ...ready, mainReady: false, phase: 'team-backups' });
  await f.acknowledgments[1]!.promise; assert.equal(f.discovery(), 0);
  reads[1]!.resolve({ ...ready, uiDidInit: false, rootChildCount: 0 });
  await f.acknowledgments[2]!.promise; assert.equal(f.discovery(), 0);
  reads[2]!.resolve({ ...ready, storePresent: false }); // Packed builds expose no DEV store.
  assert.deepEqual(await pending, { kind: 'read', value: { state: 'ready', bindings: [] } });
  assert.equal(f.discovery(), 1);
});

test('the original remaining startup deadline rejects a pending snapshot without late discovery or a reset', { timeout: 5000 }, async () => {
  const held = deferred<Record<string, unknown>>(), f = fixture([held]);
  const pending = f.start(500);
  const rejected = assert.rejects(pending, /Main\/UI startup readiness timed out; no mutation retry/);
  await f.acknowledgments[0]!.promise; assert.equal(f.discovery(), 0);
  await rejected; assert.equal(f.discovery(), 0);
  held.resolve(ready); await setImmediate(); assert.equal(f.discovery(), 0);
});


function readinessRuntime(expression: string, href: string, origin: string): Promise<Record<string, unknown>> {
  return Promise.resolve(runInNewContext(expression, {
    URL,
    location: { href, origin },
    window: { __claudeTeamsUiDidInit: true,
      electronAPI: { startup: { getStatus: async () => ({ ready: true, phase: 'ready' }) } } },
    document: { getElementById: () => ({ childElementCount: 1 }) },
  }) as Promise<Record<string, unknown>>);
}
async function observedReadinessExpression(rendererUrl: string, runtimeOrigin: string): Promise<string> {
  const listeners = new Map<string, (value: unknown) => void>();
  let evaluated = '';
  const cdp = {
    on(method: string, listener: (value: unknown) => void) { listeners.set(method, listener); },
    async send(method: string) {
      if (method === 'Runtime.enable') listeners.get('Runtime.executionContextCreated')?.({
        context: { id: 7, auxData: { isDefault: true, frameId: 'TEST-packed-frame' } },
      });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'TEST-packed-frame', url: rendererUrl } } };
      if (method === 'Runtime.evaluate') return { result: { value: { url: rendererUrl, readyState: 'complete' } } };
      return {};
    },
    async evaluate(expression: string) {
      evaluated = expression;
      return readinessRuntime(expression, rendererUrl, runtimeOrigin);
    },
  };
  const evidence: Record<string, unknown> = {};
  await attachRendererDiagnostics(cdp, rendererUrl, evidence, { remainingMs: 1000, assertOwnedRenderer() {} });
  const diagnostics = evidence.rendererDiagnostics as { startup: { appReadiness: { status: string } } };
  assert.equal(diagnostics.startup.appReadiness.status, 'READY');
  assert.ok(evaluated);
  return evaluated;
}

test('packed file readiness executes the actual diagnostic expression using exact href instead of Electron opaque origin', { timeout: 5000 }, async () => {
  const expected = 'file:///Volumes/TEST%20candidate/Agent.app/Contents/Resources/app.asar/out/renderer/index.html';
  assert.equal(new URL(expected).origin, 'null');
  const expression = await observedReadinessExpression(expected, 'file://');
  for (const href of [expected, expected + '#same-document-route'])
    assert.equal((await readinessRuntime(expression, href, 'file://')).originMatches, true, href);
  for (const href of [
    expected.replace('index.html', 'other.html'),
    expected.replace('/TEST%20candidate/', '/OTHER/'),
    expected.replace('file:///', 'file://foreign/'),
    expected + '?different-document-input',
    'https://foreign.example/index.html', 'not a URL',
  ]) assert.equal((await readinessRuntime(expression, href, 'file://')).originMatches, false, href);
});

test('HTTP readiness keeps exact origin and document path guards when the runtime location origin is untrusted', { timeout: 5000 }, async () => {
  const expected = 'http://localhost:5173/index.html';
  const expression = await observedReadinessExpression(expected, 'http://localhost:5173');
  assert.equal((await readinessRuntime(expression, expected + '#same-document-route', 'http://localhost:5173')).originMatches, true);
  for (const href of ['http://localhost:5173/other.html', 'http://localhost:5174/index.html',
    'https://localhost:5173/index.html', 'http://foreign.example:5173/index.html'])
    assert.equal((await readinessRuntime(expression, href, 'http://localhost:5173')).originMatches, false, href);
});
