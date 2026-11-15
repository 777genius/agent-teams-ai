import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForNativeProcessServices } from './desktop-native-process-model.ts';
import { prepareControlledProcessFixture } from './desktop-controlled-process-fixture.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
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
test('background acceptance waits for atomic service publication without masking corrupt readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-native-service-readiness-'));
  const path = join(root, 'services.json');
  const services = { primary: { role: 'primary', nonce: 'TEST-primary', pid: 123, port: 1234, url: 'http://127.0.0.1:1234/TEST-primary' },
    neighbor: { role: 'neighbor', nonce: 'TEST-neighbor', pid: 456, port: 5678, url: 'http://127.0.0.1:5678/TEST-neighbor' } };
  let reads = 0;
  const publication = delay(100).then(async () => {
    await writeFile(path + '.pending', JSON.stringify(services), { flag: 'wx' });
    await rename(path + '.pending', path);
  });
  try {
    const actual = await waitForNativeProcessServices(async () => {
      reads++;
      return JSON.parse(await readFile(path, 'utf8')) as typeof services;
    });
    assert.deepEqual(actual, services);
    assert.ok(reads >= 2, 'initial missing publication was observed');
    await writeFile(path, '{');
    let invalidReads = 0;
    await assert.rejects(waitForNativeProcessServices(async () => {
      invalidReads++;
      return JSON.parse(await readFile(path, 'utf8')) as typeof services;
    }), SyntaxError);
    assert.equal(invalidReads, 1, 'present but invalid evidence is never retried');
    await assert.rejects(waitForNativeProcessServices(async () => {
      await readFile(join(root, 'never-published'));
      return services;
    }, 25), /did not publish before the deadline/);
  } finally { await publication; await rm(root, { recursive: true, force: true }); }
});

test('captured no-provider Processes fixture rejects mixed inputs before allocating and seeds no Runtime', {
  skip: process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_PATH === undefined && 'requires the isolated Processes lane original native artifact capture',
}, async (t) => {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  const repo = await realpath(join(import.meta.dirname, '../..'));
  const pnpm = process.env.LEGACY_DESKTOP_PNPM_PATH!;
  const originalPath = process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_PATH!, originalSha = process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_SHA256!;
  const source = JSON.parse(await readFile(originalPath, 'utf8'));
  assert.equal(source.kind, 'TEST-controlled-process-no-provider-v1');
  assert.equal(await fileDigest(originalPath), originalSha);
  const root = await mkdtemp(join(tmpdir(), 'TEST-process-input-validation-'));
  t.after(async () => {
    process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_PATH = originalPath;
    process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_SHA256 = originalSha;
    await rm(root, { recursive: true, force: true });
  });
  for (const [index, capture] of [
    { ...source, kind: 'unselected' },
    { ...source, claude: { path: '/TEST-never-executed', sha256: 'a'.repeat(64) } },
    { ...source, node: { ...source.node, extra: true } },
    { ...source, corepack: { ...source.corepack, extra: true } },
  ].entries()) {
    const path = join(root, `capture-${index}.json`);
    await writeFile(path, JSON.stringify(capture), { flag: 'wx', mode: 0o600 });
    process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_PATH = path;
    process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_SHA256 = await fileDigest(path);
    await assert.rejects(prepareControlledProcessFixture(repo, pnpm), { code: 'ERR_ASSERTION' });
  }
  process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_PATH = originalPath;
  process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_SHA256 = '0'.repeat(64);
  await assert.rejects(prepareControlledProcessFixture(repo, pnpm), { code: 'ERR_ASSERTION' });
  process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_SHA256 = originalSha;
  const fixture = await prepareControlledProcessFixture(repo, pnpm);
  t.after(async () => { await fixture.controlledProcess.cleanup(); await rm(fixture.root, { recursive: true, force: true }); });
  const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8'));
  const descriptor = JSON.parse(await readFile(fixture.descriptorPath, 'utf8'));
  assert.equal(profile.runtime, undefined); assert.equal(profile.management, undefined);
  assert.equal(descriptor.management, undefined);
  assert.ok(profile.teams.every((team: { members: { delivery?: unknown }[] }) => team.members.every(member => member.delivery === undefined)));
  await assert.rejects(lstat(join(fixture.root, 'hoststore/runtime-sessions')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(fixture.root, 'workspace/process-primary.json')), { code: 'ENOENT' });
  assert.equal(fixture.controlledProcess.proof.captureKind, source.kind);
  assert.equal(fixture.controlledProcess.proof.providersConfigured, false);
  assert.equal(fixture.controlledProcess.proof.status, 'INCOMPLETE', 'preparation does not claim actual process/UI qualification');
});


test('original same-Main Retry retains a bounded first UI refusal without changing the read or its error', async () => {
  const { createDesktopUiControls, desktopJsLiteral } = await import('./desktop-ui-controls.ts');
  const source = (await readFile(new URL('../../tools/owned-process-broker/nativeWindowsAppGate.mjs', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  const begin = "  begin('one-explicit-same-Main-Retry', 10000);", end = '  await originalBinding();\n  await within(() => fixture.afterRetry(activeDeadline));';
  assert.equal(source.split(begin).length, 2); assert.equal(source.split(end).length, 2);
  const block = source.slice(source.indexOf(begin), source.indexOf(end));
  const run = Function('environment', `'use strict'; const {assert,begin,proof,ui,surface,poll,readWriter,writerA,assertHost,
    captureCensus,hostA,assertHostBirths,desktopJsLiteral,remaining,performance,startedAt}=environment;
    let hostB; return (async()=>{${block}})();`) as (environment: Record<string, unknown>) => Promise<void>;
  type Mode = 'surface-missing' | 'refresh-not-enabled' | 'retry-present' | 'alert-present' | 'ready';
  type Diagnostic = { stages: Record<string, number | null>; returnedReads: number; countTruncated: boolean;
    last: { atMs: number | null; result: string } | null };
  const exercise = async (modes: Mode[], fault?: 'clock' | 'write', retrySibling = false) => {
    const failure = new Error('TEST retained original read refusal');
    const calls: string[] = [], dom: string[][] = [];
    const proof: { counts: { retryClicks: number }; phases: { phase: string; atMs: number; budgetMs: number }[];
      retryUi?: Diagnostic } = { counts: { retryClicks: 0 }, phases: [] };
    if (fault === 'write') Object.defineProperty(proof, 'retryUi', { set() { throw new Error('TEST diagnostic write'); } });
    let read = 0, clocks = 0, predicate: (value: unknown) => boolean = Boolean;
    const controls = createDesktopUiControls({
      send: async () => { assert.fail('the original waitRead sends no input'); },
      evaluate: async (expression: string) => {
        calls.push('evaluate');
        const mode = modes[read++]; if (mode === undefined) throw failure;
        const trace: string[] = []; dom.push(trace);
        const refresh = { get textContent() { trace.push('refresh:text'); return 'Refresh'; },
          get disabled() { trace.push('refresh:disabled'); return mode === 'refresh-not-enabled'; } };
        const retry = { get textContent() { trace.push('retry:text'); return 'Retry'; },
          get disabled() { return assert.fail('Retry disabled is not read by the original predicate'); } };
        const surface = {
          querySelectorAll: (selector: string) => { assert.equal(selector, 'button'); trace.push('buttons');
            return mode === 'retry-present' || retrySibling ? [refresh, retry] : [refresh]; },
          querySelector: (selector: string) => { assert.equal(selector, '[role="alert"]'); trace.push('alert');
            return mode === 'alert-present' ? {} : null; },
        };
        return Function('document', 'return ' + expression)({ querySelector: (selector: string) => {
          assert.equal(selector, '[data-testid="host-backend-recovery"]'); trace.push('surface');
          return mode === 'surface-missing' ? null : surface;
        } });
      },
    }, { assertOwnedRenderer: () => { calls.push('guard'); }, step: () => { assert.fail('no extra UI step'); } });
    const writer = { pid: 2, token: 'TEST-successor' }, host = { pid: 2 }, census = [host];
    let error: unknown;
    try {
      await run({ assert, proof, desktopJsLiteral, startedAt: 1000,
        begin: (phase: string, budgetMs: number) => { calls.push('begin');
          assert.equal(phase, 'one-explicit-same-Main-Retry'); assert.equal(budgetMs, 10000);
          proof.phases.push({ phase, atMs: 0, budgetMs }); },
        surface: '[data-testid="host-backend-recovery"]',
        ui: {
          click: async (selector: string, label: string, text: string) => { calls.push('click');
            assert.equal(selector, '[data-testid="host-backend-recovery"] button');
            assert.equal(label, 'explicit product Retry once'); assert.equal(text, 'Retry'); },
          waitRead: (expression: string, label: string, budget: number, ready: (value: unknown) => boolean = Boolean) => {
            calls.push('waitRead'); assert.equal(label, 'original refreshed Team after positive product recovery');
            assert.equal(budget, 10000); predicate = ready;
            return controls.waitRead(expression, label, budget, ready);
          },
        },
        poll: async (readWriter: () => unknown, label: string) => { calls.push('poll');
          assert.equal(label, 'actual successor writer acquisition'); return readWriter(); },
        readWriter: () => { calls.push('writer'); return writer; }, writerA: { pid: 1, token: 'TEST-original' },
        captureCensus: () => { calls.push('census'); return census; },
        assertHost: (actual: unknown, observed: unknown) => { calls.push('host');
          assert.equal(actual, writer); assert.equal(observed, census); return host; },
        hostA: { pid: 1 }, assertHostBirths: () => { calls.push('births'); },
        remaining: () => { calls.push('remaining'); return 10000; },
        performance: { now: () => { clocks++; if (fault === 'clock') throw new Error('TEST diagnostic clock'); return 1000 + clocks; } },
      });
    } catch (caught) { error = caught; }
    return { proof, error, failure, calls, dom, predicate };
  };
  const initialCalls = ['begin', 'click', 'poll', 'writer', 'census', 'host', 'births', 'remaining', 'waitRead'];
  const retryTrace = ['surface', 'buttons', 'refresh:text', 'refresh:disabled', 'refresh:text', 'retry:text'];
  const refused = await exercise(['retry-present']);
  assert.equal(refused.error, refused.failure, 'retain the identical original read error after the false sample');
  assert.deepEqual(refused.calls, [...initialCalls, 'guard', 'evaluate', 'guard', 'evaluate']);
  assert.deepEqual(refused.dom, [retryTrace]); assert.equal(refused.proof.counts.retryClicks, 1);
  assert.equal(refused.proof.retryUi?.last?.result, 'retry-present', 'retain the first original UI refusal');
  assert.deepEqual(refused.proof.retryUi, { stages: { clickReturnedMs: 1, writerObservedMs: 2, hostCheckedMs: 3, uiReadyMs: null },
    returnedReads: 1, countTruncated: false, last: { atMs: 4, result: 'retry-present' } });
  const ready = await exercise(['surface-missing', 'refresh-not-enabled', 'retry-present', 'alert-present', 'ready']);
  assert.equal(ready.error, undefined); assert.equal(ready.proof.counts.retryClicks, 1);
  assert.deepEqual(ready.calls, [...initialCalls, ...Array.from({ length: 5 }, () => ['guard', 'evaluate']).flat()]);
  assert.deepEqual(ready.dom, [
    ['surface'], ['surface', 'buttons', 'refresh:text', 'refresh:disabled'], retryTrace,
    ['surface', 'buttons', 'refresh:text', 'refresh:disabled', 'refresh:text', 'alert'],
    ['surface', 'buttons', 'refresh:text', 'refresh:disabled', 'refresh:text', 'alert'],
  ]);
  assert.deepEqual(ready.proof.retryUi, { stages: { clickReturnedMs: 1, writerObservedMs: 2, hostCheckedMs: 3, uiReadyMs: 9 },
    returnedReads: 5, countTruncated: false, last: { atMs: 8, result: 'ready' } });
  for (const invalid of [true, false, null, 'unknown', ['ready'], { toString() { assert.fail('no result coercion'); } }])
    assert.equal(refused.predicate(invalid), false);
  for (let count = 0; count < 501; count++) assert.equal(refused.predicate('ready'), true);
  assert.equal(refused.proof.retryUi?.returnedReads, 500); assert.equal(refused.proof.retryUi?.countTruncated, true);
  assert.equal(refused.proof.retryUi?.last?.result, 'ready');
  assert.deepEqual(refused.calls, [...initialCalls, 'guard', 'evaluate', 'guard', 'evaluate'], 'counter saturation adds no reads or actions');
  const maximum = { ...refused.proof.retryUi,
    stages: Object.fromEntries(Object.keys(refused.proof.retryUi!.stages).map(key => [key, Number.MAX_SAFE_INTEGER])),
    last: { atMs: Number.MAX_SAFE_INTEGER, result: 'refresh-not-enabled' } };
  assert.ok(JSON.stringify(maximum).length <= 1024, 'the closed ASCII diagnostic fits its separate byte bound');
  for (const fault of ['clock', 'write'] as const) {
    const refused = await exercise(['retry-present'], fault), ready = await exercise(['ready'], fault);
    assert.equal(refused.error, refused.failure); assert.equal(ready.error, undefined);
    assert.deepEqual(refused.calls, [...initialCalls, 'guard', 'evaluate', 'guard', 'evaluate']);
    assert.deepEqual(ready.calls, [...initialCalls, 'guard', 'evaluate']);
    assert.equal(refused.proof.counts.retryClicks, 1); assert.equal(ready.proof.counts.retryClicks, 1);
  }

  const noRead = await exercise([]);
  assert.equal(noRead.error, noRead.failure, 'preserve a refusal before the first completed UI value');
  assert.deepEqual(noRead.calls, [...initialCalls, 'guard', 'evaluate']);
  assert.deepEqual(noRead.dom, []); assert.equal(noRead.proof.counts.retryClicks, 1);
  assert.deepEqual(noRead.proof.retryUi, { stages: { clickReturnedMs: 1, writerObservedMs: 2, hostCheckedMs: 3, uiReadyMs: null },
    returnedReads: 0, countTruncated: false, last: null });

  const refreshBlocked = await exercise(['refresh-not-enabled'], undefined, true);
  assert.equal(refreshBlocked.error, refreshBlocked.failure);
  assert.deepEqual(refreshBlocked.calls, [...initialCalls, 'guard', 'evaluate', 'guard', 'evaluate']);
  assert.deepEqual(refreshBlocked.dom, [['surface', 'buttons', 'refresh:text', 'refresh:disabled', 'retry:text']]);
  assert.equal(refreshBlocked.proof.retryUi?.last?.result, 'refresh-not-enabled');
  assert.equal(refreshBlocked.proof.retryUi?.returnedReads, 1); assert.equal(refreshBlocked.proof.counts.retryClicks, 1);

  const frozenRecord = Object.freeze(refused.proof.retryUi!);
  const frozenBefore = structuredClone(frozenRecord), frozenCalls = [...refused.calls];
  assert.equal(refused.predicate('ready'), true);
  assert.equal(refused.predicate('retry-present'), false);
  assert.deepEqual(refused.proof.retryUi, frozenBefore, 'diagnostic immutability does not decide readiness');
  assert.deepEqual(refused.calls, frozenCalls, 'diagnostic refusal adds no reads or input');
});


test('original first failure retains one bounded stdout prefix before the unchanged cleanup boundary', async () => {
  const { Buffer } = await import('node:buffer');
  const source = (await readFile(new URL('../../tools/owned-process-broker/nativeWindowsAppGate.mjs', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  const start = '} catch (error) {\n  primaryError = error;', end = '} finally {\n  if (app && !quitStarted) {';
  assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2);
  const body = source.slice(source.indexOf(start) + '} catch (error) {\n'.length, source.indexOf(end));
  const run = Function('environment', `const {error,errorText,proof,activePhase,Buffer,writeSync}=environment;
    let primaryError; ${body} return {primaryError,proof};`) as (environment: Record<string, unknown>) => {
      primaryError: unknown; proof: { error?: string } };
  const originalError = new Error('TEST original failure'), phase = 'actual-Host-A-exit-and-metadata-Refresh';
  const formatted = 'Error: TEST original failure\n    at TEST original frame';
  const exercise = (text = formatted, activePhase = phase, sink: 'ok' | 'throw' | 'partial' = 'ok') => {
    const calls: string[] = [], writes: { fd: number; line: string }[] = [];
    const proof: { error?: string } = {};
    let result: ReturnType<typeof run> | undefined;
    try {
      result = run({ error: originalError, proof, activePhase, Buffer,
        errorText: (error: unknown) => { calls.push('format'); assert.equal(error, originalError); return text; },
        writeSync: (fd: number, line: string) => { calls.push('write'); writes.push({ fd, line });
          if (sink === 'throw') throw new Error('TEST unavailable diagnostic sink');
          return sink === 'partial' ? 1 : Buffer.byteLength(line, 'utf8'); },
      });
    } finally { calls.push('cleanup-boundary'); }
    assert.equal(result?.primaryError, originalError); assert.equal(result?.proof, proof);
    assert.equal(proof.error, text); assert.equal(calls.filter(value => value === 'format').length, 1);
    assert.equal(calls.at(-1), 'cleanup-boundary');
    return { writes, calls };
  };
  const retained = exercise();
  assert.equal(retained.writes.length, 1, 'retain the already formatted first failure before cleanup');
  assert.deepEqual(retained.calls, ['format', 'write', 'cleanup-boundary']);
  assert.equal(retained.writes[0]!.fd, 1); assert.ok(retained.writes[0]!.line.endsWith('\n'));
  assert.deepEqual(JSON.parse(retained.writes[0]!.line), {
    kind: 'TEST_WINDOWS_PACKAGED_UI_FAILURE', phase, error: formatted,
  });
  const unicode = 'Error: ' + '\u{1f642}'.repeat(100) + ' TEST unretained suffix';
  const truncated = exercise(unicode);
  assert.equal(JSON.parse(truncated.writes[0]!.line).error, unicode.slice(0, 128));
  assert.equal(JSON.parse(truncated.writes[0]!.line).error.length, 128);
  assert.ok(Buffer.byteLength(truncated.writes[0]!.line, 'utf8') <= 1024);
  const overhead = Buffer.byteLength(JSON.stringify({ kind: 'TEST_WINDOWS_PACKAGED_UI_FAILURE', phase: '', error: formatted }) + '\n', 'utf8');
  const boundary = exercise(formatted, 'A'.repeat(1024 - overhead));
  assert.equal(boundary.writes.length, 1); assert.equal(Buffer.byteLength(boundary.writes[0]!.line, 'utf8'), 1024);
  const oversized = exercise(formatted, 'A'.repeat(1025 - overhead));
  assert.equal(oversized.writes.length, 0); assert.deepEqual(oversized.calls, ['format', 'cleanup-boundary']);
  const utf8 = exercise(formatted, '\u754c'.repeat(400));
  assert.equal(utf8.writes.length, 0, 'the cap measures UTF8 bytes, not JavaScript character count');
  for (const sink of ['throw', 'partial'] as const) {
    const observed = exercise(formatted, phase, sink);
    assert.equal(observed.writes.length, 1); assert.deepEqual(observed.calls, ['format', 'write', 'cleanup-boundary']);
  }
});
