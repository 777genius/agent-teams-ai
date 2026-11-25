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
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';

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
test('background acceptance waits for atomic service publication without masking corrupt readiness', async (t) => {
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
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    try {
      for (const elapsed of [9, 10, 11]) {
        t.mock.timers.setTime(1000);
        let completedReads = 0;
        const completed = waitForNativeProcessServices(async () => {
          completedReads++;
          t.mock.timers.setTime(1000 + elapsed);
          return services;
        }, 10);
        if (elapsed < 10) assert.deepEqual(await completed, services);
        else await assert.rejects(completed, /did not publish before the deadline/);
        assert.equal(completedReads, 1, 'the original read is never replayed');
      }
      t.mock.timers.setTime(1000);
      let cutoffReads = 0;
      const cutoff = waitForNativeProcessServices(async () => {
        cutoffReads++;
        throw Object.assign(new Error('TEST missing publication'), { code: 'ENOENT' });
      }, 50);
      const rejected = assert.rejects(cutoff, /did not publish before the deadline/);
      await Promise.resolve();
      t.mock.timers.tick(50);
      await rejected;
      assert.equal(cutoffReads, 1, 'the expired deadline cannot start another read');
    } finally { t.mock.timers.reset(); }
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

test('Windows outage membership requires both original process owners in one renderer sample', async () => {
  const source = (await readFile(new URL('../../tools/owned-process-broker/nativeWindowsAppGate.mjs', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  const start = "  'genuine closed Host read marker with separate controls', remaining());\n";
  const end = "\n\n  assertHostBirths();\n  begin('one-explicit-same-Main-Retry', 10000);";
  assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2);
  const from = source.indexOf(start) + start.length, to = source.indexOf(end, from);
  assert(to > from);
  const execute = Function('assert', 'ui', 'original', 'processOwner', 'remaining', 'object',
    'return (async () => {' + source.slice(from, to) + '\n})();');
  const selectedStart = 'const processOwner = (row, stopped = false) =>';
  const selectedEnd = '\nconst readProcesses = async () => {';
  assert.equal(source.split(selectedStart).length, 2); assert.equal(source.split(selectedEnd).length, 2);
  const selectedFrom = source.indexOf(selectedStart), selectedTo = source.indexOf(selectedEnd, selectedFrom);
  assert(selectedTo > selectedFrom);
  const selectedTeam = 'TEST-original-owner-qualified-team';
  const processOwner = Function('desktopProcessOwnerExpression', 'selection',
    source.slice(selectedFrom, selectedTo) + '\nreturn processOwner;')(desktopProcessOwnerExpression, selectedTeam);
  const rows = [
    { id: 'TEST-primary', processRef: 'TEST-original-primary' },
    { id: 'TEST-neighbor', processRef: 'TEST-original-neighbor' },
  ];
  const object = (value: unknown) => {
    assert(value && typeof value === 'object' && !Array.isArray(value)); return value;
  };
  const unavailable = new Error('TEST original remaining observation allowance exhausted');
  const frame = (processes: typeof rows, teamName = selectedTeam) => ({ processes, teamName });
  const observe = (
    frames: (ReturnType<typeof frame> | Error)[],
    { guardError, remainingError }: { guardError?: Error; remainingError?: Error } = {}
  ) => {
    let waits = 0, reads = 0, checks = 0, remainingReads = 0;
    return {
      run: () => execute(assert, {
        waitRead: async (expression: string, label: string, budget: number): Promise<unknown> => {
          waits++;
          assert.equal(label, 'original rows retained during outage'); assert.equal(budget, 7500);
          for (let sample = 0; sample < frames.length; sample++) {
            checks++;
            if (guardError) throw guardError;
            const current = frames[Math.min(reads++, frames.length - 1)]; assert(current);
            if (current instanceof Error) throw current;
            const section = { querySelectorAll: () => [],
              __reactFiber$TEST: { memoizedProps: { ...current, isTeamAlive: false }, alternate: null, return: null } };
            const document = { querySelector: (selector: string) => {
              assert.equal(selector, '[data-section-id="processes"]'); return section;
            } };
            const value = Function('document', 'return ' + expression)(document);
            if (value) return value;
          }
          throw unavailable;
        },
      }, { rows }, processOwner, () => {
        remainingReads++;
        if (remainingError) throw remainingError;
        return 7500;
      }, object),
      counts: () => ({ waits, reads, checks, remainingReads }),
    };
  };

  // The old two waits accepted primary from one sample and neighbor from another.
  const separate = observe([frame([rows[0]!]), frame([rows[1]!])]);
  await assert.rejects(separate.run(), error => error === unavailable);
  assert.deepEqual(separate.counts(), { waits: 1, reads: 2, checks: 2, remainingReads: 1 });
  const together = observe([frame(rows)]);
  await together.run();
  assert.deepEqual(together.counts(), { waits: 1, reads: 1, checks: 1, remainingReads: 1 });
  const laterTogether = observe([frame([rows[0]!]), frame([rows[1]!]), frame(rows)]);
  await laterTogether.run();
  assert.deepEqual(laterTogether.counts(), { waits: 1, reads: 3, checks: 3, remainingReads: 1 });

  for (const invalid of [
    frame(rows, 'TEST-foreign-owner-qualified-team'),
    frame([{ ...rows[0]!, id: 'TEST-wrong-id' }, rows[1]!]),
    frame([{ ...rows[0]!, processRef: 'TEST-replacement-ref' }, rows[1]!]),
    frame([rows[0]!, rows[0]!, rows[1]!]),
    frame([]),
  ]) await assert.rejects(observe([invalid]).run(), error => error === unavailable);
  const guard = new Error('TEST original owner changed'), cutoff = new Error('TEST original phase expired');
  const blocked = observe([frame(rows)], { guardError: guard });
  await assert.rejects(blocked.run(), error => error === guard);
  assert.deepEqual(blocked.counts(), { waits: 1, reads: 0, checks: 1, remainingReads: 1 });
  const expired = observe([frame(rows)], { remainingError: cutoff });
  await assert.rejects(expired.run(), error => error === cutoff);
  assert.deepEqual(expired.counts(), { waits: 0, reads: 0, checks: 0, remainingReads: 1 });
  const evaluation = new Error('TEST original renderer evaluation failed');
  await assert.rejects(observe([evaluation]).run(), error => error === evaluation);
});


test('Windows Retry retains same-evaluation operands without changing the original wait', async () => {
  const source = (await readFile(new URL('../../tools/owned-process-broker/nativeWindowsAppGate.mjs', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  const start = "  begin('one-explicit-same-Main-Retry', 10000);";
  const end = '  await originalBinding();\n  await within(() => fixture.afterRetry(activeDeadline));';
  assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2);
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert(to > from);
  const execute = Function('environment', '"use strict"; const {assert,begin,proof,ui,surface,poll,readWriter,writerA,' +
    'assertHost,captureCensus,hostA,assertHostBirths,desktopJsLiteral,remaining,performance,startedAt}=environment;' +
    'let hostB; return (async () => {' + source.slice(from, to) + '\n})();') as
    (environment: Record<string, unknown>) => Promise<void>;
  const surface = '[data-testid="host-backend-recovery"]';
  const label = 'original refreshed Team after positive product recovery';
  const button = (text: string, disabled: boolean | Error = false, busy: unknown = 'false', trace?: string[]) => {
    const calls = { text: 0, disabled: 0, busy: 0 }, kind = text === 'Retry' ? 'retry' : 'refresh';
    return { calls, node: {
      get textContent() { calls.text++; trace?.push(kind + ':text'); return text; },
      get disabled() {
        calls.disabled++; trace?.push(kind + ':disabled');
        if (text === 'Retry') return assert.fail('Retry disabled is not read by the original predicate');
        if (disabled instanceof Error) throw disabled; return disabled;
      },
      getAttribute(name: string) {
        assert.equal(name, 'aria-busy'); calls.busy++; trace?.push(kind + ':busy');
        if (busy instanceof Error) throw busy;
        return busy;
      },
    } };
  };
  const frame = (buttons: ReturnType<typeof button>[], present = true, alert = false, trace?: string[]) => {
    const calls = { surface: 0, buttons: 0, alert: 0 };
    const root = {
      querySelectorAll(selector: string) {
        assert.equal(selector, 'button'); calls.buttons++; trace?.push('buttons'); return buttons.map(value => value.node);
      },
      querySelector(selector: string) {
        assert.equal(selector, '[role="alert"]'); calls.alert++; trace?.push('alert'); return alert ? {} : null;
      },
    };
    return { calls, document: { querySelector(selector: string) {
      assert.equal(selector, surface); calls.surface++; trace?.push('surface'); return present ? root : null;
    } } };
  };
  const observe = (frames: (ReturnType<typeof frame> | Error)[], options: {
    proof?: Record<string, unknown>; guardError?: Error; remainingError?: Error; budget?: number;
    clock?: 'throw' | 'nan' | 'negative' | 'unsafe'; originFault?: boolean;
  } = {}) => {
    const proof: Record<string, unknown> = options.proof ?? {};
    const effects = { retryClicks: 0 }, phases: { phase: string; atMs: number; budgetMs: number }[] = [];
    proof.counts = effects; proof.phases = phases;
    const counts = { waits: 0, reads: 0, guards: 0, remaining: 0, births: 0, sends: 0, steps: 0 };
    const setup = { begins: 0, clicks: 0, polls: 0, writers: 0, censuses: 0, hosts: 0 }, events: string[] = [];
    let capturedReady: ((value: unknown) => boolean) | undefined, clocks = 0, scripts = 0;
    const controls = createDesktopUiControls({
      async evaluate(expression: string): Promise<unknown> {
        events.push('evaluate'); const current = frames[counts.reads++]; assert(current);
        if (current instanceof Error) throw current;
        scripts++; return Function('document', 'return ' + expression)(current.document);
      },
      async send() { counts.sends++; throw new Error('TEST no input is authorized by this observation'); },
    }, {
      assertOwnedRenderer() { events.push('guard'); counts.guards++; if (options.guardError) throw options.guardError; },
      step() { counts.steps++; },
    });
    const ui = {
      async click(selector: string, actualLabel: string, text: string) {
        events.push('click'); setup.clicks++; assert.equal(selector, surface + ' button');
        assert.equal(actualLabel, 'explicit product Retry once'); assert.equal(text, 'Retry');
      },
      waitRead(expression: string, actualLabel: string, budget: number, isReady?: (value: unknown) => boolean) {
        events.push('waitRead'); counts.waits++; assert.equal(actualLabel, label);
        assert.equal(budget, options.budget ?? 2000); capturedReady = isReady;
        return controls.waitRead(expression, actualLabel, budget, isReady);
      },
    };
    const writer = { pid: 2, token: 'TEST-successor' }, host = { pid: 2 }, census = [host];
    const done = execute({ assert, proof, ui, surface, desktopJsLiteral, startedAt: 1000,
      begin(phase: string, budgetMs: number) {
        events.push('begin'); setup.begins++; assert.equal(phase, 'one-explicit-same-Main-Retry');
        assert.equal(budgetMs, 10000); phases.push({ phase, atMs: 0, budgetMs });
        if (options.originFault) Object.defineProperty(phases.at(-1)!, 'atMs', {
          get() { return assert.fail('TEST diagnostic phase origin failed'); },
        });
      },
      async poll(readWriter: () => unknown, actualLabel: string) {
        events.push('poll'); setup.polls++; assert.equal(actualLabel, 'actual successor writer acquisition');
        return readWriter();
      },
      readWriter() { events.push('writer'); setup.writers++; return writer; },
      writerA: { pid: 1, token: 'TEST-original' }, hostA: { pid: 1 },
      captureCensus() { events.push('census'); setup.censuses++; return census; },
      assertHost(actual: unknown, observed: unknown) {
        events.push('host'); setup.hosts++; assert.equal(actual, writer); assert.equal(observed, census); return host;
      },
      assertHostBirths() { events.push('births'); counts.births++; },
      remaining() {
        events.push('remaining'); counts.remaining++; if (options.remainingError) throw options.remainingError;
        return options.budget ?? 2000;
      },
      performance: { now() {
        clocks++; if (options.clock === 'throw') throw new Error('TEST diagnostic clock failed');
        if (options.clock === 'nan') return NaN; if (options.clock === 'negative') return 999;
        if (options.clock === 'unsafe') return Number.MAX_SAFE_INTEGER + 10000;
        return 1000 + clocks;
      } },
    });
    return { proof, counts, setup, effects, events, clocks: () => clocks, scripts: () => scripts,
      ready: () => capturedReady, done };
  };
  type RecoveryFacts = { surfacePresent: boolean; refresh: string; firstRefreshBusy: boolean | null;
    retryPresent: boolean | null; alertPresent: boolean | null; ready: boolean };
  const ready: RecoveryFacts = { surfacePresent: true, refresh: 'enabled', firstRefreshBusy: false,
    retryPresent: false, alertPresent: false, ready: true };
  const expected = (last: RecoveryFacts | null, sampleCount = 1, sampleCountCapped = false,
    lastAtMs: number | null = last === null ? null : 4, uiReadyMs: number | null = last?.ready ? 5 : null) => ({
    schemaVersion: 1, source: 'original-recovery-wait', atomicWithFailure: false,
    stages: { clickReturnedMs: 1, writerObservedMs: 2, hostCheckedMs: 3, uiReadyMs },
    sampleCount, sampleCountCapped, lastAtMs, last,
  });
  const initialEvents = ['begin', 'click', 'poll', 'writer', 'census', 'host', 'births', 'remaining', 'waitRead'];
  const expectedSetup = { begins: 1, clicks: 1, polls: 1, writers: 1, censuses: 1, hosts: 1 };
  const initial = button('Refresh'), initialFrame = frame([initial]);
  const success = observe([initialFrame]);
  await success.done;
  assert.deepEqual(success.setup, expectedSetup); assert.equal(success.effects.retryClicks, 1);
  assert.deepEqual(success.events, [...initialEvents, 'guard', 'evaluate']);
  assert.deepEqual(success.counts, { waits: 1, reads: 1, guards: 1, remaining: 1, births: 1, sends: 0, steps: 0 });
  assert.deepEqual(initial.calls, { text: 2, disabled: 1, busy: 1 });
  assert.deepEqual(initialFrame.calls, { surface: 1, buttons: 1, alert: 1 });
  assert.deepEqual(success.proof.retryUiObservation, expected(ready),
    'the same successful original wait must retain its selected stage and sample timings');
  assert.equal(success.clocks(), 5);

  const stop = new Error('TEST original finite evaluation stops after its retained false sample');
  const falseFrames = [
    { dom: frame([], false), facts: { ...ready, surfacePresent: false, refresh: 'not-observed',
      firstRefreshBusy: null, retryPresent: null, alertPresent: null, ready: false } },
    { dom: frame([button('TEST private unrelated content')]), facts: { ...ready, refresh: 'absent',
      firstRefreshBusy: null, retryPresent: null, alertPresent: null, ready: false } },
    { dom: frame([button('Refresh', true, 'true')]), facts: { ...ready, refresh: 'disabled',
      firstRefreshBusy: true, retryPresent: null, alertPresent: null, ready: false } },
    { dom: frame([button('Refresh'), button('Retry')]), facts: { ...ready,
      retryPresent: true, alertPresent: null, ready: false } },
    { dom: frame([button('Refresh')], true, true), facts: { ...ready, alertPresent: true, ready: false } },
  ];
  for (const { dom, facts } of falseFrames) {
    const current = observe([dom, stop]);
    await assert.rejects(current.done, error => error === stop);
    assert.deepEqual(current.proof.retryUiObservation, expected(facts));
    assert.equal(dom.calls.alert, facts.alertPresent === null ? 0 : 1);
    assert.equal(current.counts.reads, 2); assert.equal(current.counts.guards, 2);
    assert.equal(current.counts.sends + current.counts.steps, 0);
    assert(!JSON.stringify(current.proof).includes('TEST private'));
  }
  const first = button('Refresh', true, 'true'), later = button('Refresh', false, 'false');
  const duplicate = observe([frame([first, later])]); await duplicate.done;
  assert.deepEqual(duplicate.proof.retryUiObservation, expected({ ...ready, firstRefreshBusy: true }));
  assert.equal(first.calls.busy, 1); assert.equal(later.calls.busy, 0);
  for (const busy of [null, 'TEST private unknown busy', new Error('TEST attribute observer failed')]) {
    const current = observe([frame([button('Refresh', false, busy)])]); await current.done;
    assert.deepEqual(current.proof.retryUiObservation, expected({ ...ready, firstRefreshBusy: null }));
    assert(!JSON.stringify(current.proof).includes('TEST private'));
  }
  const transient = observe([new Error('Execution context was destroyed'), frame([button('Refresh')])]);
  await transient.done; assert.deepEqual(transient.proof.retryUiObservation, expected(ready));
  assert.equal(transient.counts.reads, 2); assert.equal(transient.counts.guards, 2);
  const evaluation = new Error('TEST original disabled getter failed');
  await assert.rejects(observe([frame([button('Refresh', evaluation)])]).done, error => error === evaluation);
  for (const kind of ['guardError', 'remainingError'] as const) {
    const refusal = new Error('TEST original ' + kind), current = observe([], { [kind]: refusal });
    await assert.rejects(current.done, error => error === refusal);
    assert.equal(current.counts.reads, 0); assert.equal(current.counts.sends + current.counts.steps, 0);
  }
  const expired = observe([], { budget: 0 });
  await assert.rejects(expired.done, error => error instanceof Error &&
    error.message === 'UI read timed out: ' + label + '; no mutation retry');
  assert.equal(expired.counts.reads + expired.counts.guards, 0);
  assert.deepEqual(expired.proof.retryUiObservation, expected(null, 0));
  const blockedProof = Object.defineProperty({}, 'retryUiObservation', { value: null, writable: false });
  const unwritable = observe([frame([button('Refresh')])], { proof: blockedProof });
  await unwritable.done; assert.equal(unwritable.counts.reads, 1);
  const hostileProof = {};
  Object.defineProperty(hostileProof, 'retryUiObservation', { set() { throw stop; } });
  const observerFailure = observe([frame([button('Refresh')])], { proof: hostileProof });
  await observerFailure.done; assert.equal(observerFailure.counts.reads, 1);
  const observerRefusal = observe([frame([], false), stop], { proof: hostileProof });
  await assert.rejects(observerRefusal.done, error => error === stop);
  assert.deepEqual(observerRefusal.events, [...initialEvents, 'guard', 'evaluate', 'guard', 'evaluate']);
  const noValue = observe([stop]);
  await assert.rejects(noValue.done, error => error === stop);
  assert.deepEqual(noValue.events, [...initialEvents, 'guard', 'evaluate']);
  assert.deepEqual(noValue.setup, expectedSetup); assert.equal(noValue.effects.retryClicks, 1);
  assert.equal(noValue.scripts(), 0);
  assert.deepEqual(noValue.proof.retryUiObservation, expected(null, 0));
  const siblingTrace: string[] = [], disabled = button('Refresh', true, 'true', siblingTrace);
  const sibling = button('Retry', false, 'false', siblingTrace);
  const disabledFrame = frame([disabled, sibling], true, false, siblingTrace);
  const refreshBlocked = observe([disabledFrame, stop]);
  await assert.rejects(refreshBlocked.done, error => error === stop);
  assert.deepEqual(refreshBlocked.events, [...initialEvents, 'guard', 'evaluate', 'guard', 'evaluate']);
  assert.deepEqual(siblingTrace, ['surface', 'buttons', 'refresh:text', 'refresh:disabled', 'retry:text', 'refresh:busy']);
  assert.equal(sibling.calls.disabled + disabledFrame.calls.alert, 0);
  assert.deepEqual(refreshBlocked.proof.retryUiObservation, expected({ ...ready, refresh: 'disabled',
    firstRefreshBusy: true, retryPresent: null, alertPresent: null, ready: false }));
  assert.deepEqual(refreshBlocked.setup, expectedSetup); assert.equal(refreshBlocked.effects.retryClicks, 1);
  const orderedTraces: string[][] = [];
  const orderedFrames = [0, 1, 2, 3, 4].map(mode => {
    const trace: string[] = []; orderedTraces.push(trace);
    const buttons = [button('Refresh', mode === 1, 'false', trace)];
    if (mode === 2) buttons.push(button('Retry', false, 'false', trace));
    return frame(buttons, mode !== 0, mode === 3, trace);
  });
  const ordered = observe(orderedFrames); await ordered.done;
  assert.deepEqual(ordered.events, [...initialEvents, ...Array.from({ length: 5 }, () => ['guard', 'evaluate']).flat()]);
  assert.deepEqual(ordered.setup, expectedSetup); assert.equal(ordered.effects.retryClicks, 1);
  assert.deepEqual(orderedTraces, [
    ['surface'], ['surface', 'buttons', 'refresh:text', 'refresh:disabled', 'refresh:busy'],
    ['surface', 'buttons', 'refresh:text', 'refresh:disabled', 'refresh:text', 'retry:text', 'refresh:busy'],
    ['surface', 'buttons', 'refresh:text', 'refresh:disabled', 'refresh:text', 'alert', 'refresh:busy'],
    ['surface', 'buttons', 'refresh:text', 'refresh:disabled', 'refresh:text', 'alert', 'refresh:busy'],
  ]);
  assert.deepEqual(ordered.proof.retryUiObservation, expected(ready, 5, false, 8, 9));
  const nullStages = { clickReturnedMs: null, writerObservedMs: null, hostCheckedMs: null, uiReadyMs: null };
  for (const fault of ['throw', 'nan', 'negative', 'unsafe', 'origin'] as const) {
    const faultOptions = fault === 'origin' ? { originFault: true } : { clock: fault };
    const clockReady = observe([frame([button('Refresh')])], faultOptions); await clockReady.done;
    assert.deepEqual(clockReady.proof.retryUiObservation, { ...expected(ready, 1, false, null, null), stages: nullStages });
    const clockRefused = observe([frame([], false), stop], faultOptions);
    await assert.rejects(clockRefused.done, error => error === stop);
    assert.deepEqual(clockRefused.proof.retryUiObservation, { ...expected({ ...ready, surfacePresent: false,
      refresh: 'not-observed', firstRefreshBusy: null, retryPresent: null, alertPresent: null, ready: false },
    1, false, null, null), stages: nullStages });
    assert.deepEqual(clockReady.setup, expectedSetup); assert.deepEqual(clockRefused.setup, expectedSetup);
    assert.equal(clockReady.clocks(), 5); assert.equal(clockRefused.clocks(), 4);
    assert.deepEqual(clockReady.events, [...initialEvents, 'guard', 'evaluate']);
    assert.deepEqual(clockRefused.events, [...initialEvents, 'guard', 'evaluate', 'guard', 'evaluate']);
  }
  const frozen = observe([frame([button('Refresh')])]); await frozen.done;
  const frozenRecord = Object.freeze(frozen.proof.retryUiObservation as Record<string, unknown>);
  const frozenBefore = structuredClone(frozenRecord), frozenEvents = [...frozen.events];
  const frozenAccept = frozen.ready(); assert(frozenAccept);
  assert.equal(frozenAccept(ready), true);
  assert.equal(frozenAccept({ ...ready, alertPresent: true, ready: false }), false);
  assert.deepEqual(frozenRecord, frozenBefore);
  Object.defineProperty(frozen.proof, 'retryUiObservation', { value: frozenRecord, writable: false });
  assert.equal(frozenAccept(ready), true);
  assert.equal(frozenAccept({ ...ready, alertPresent: true, ready: false }), false);
  assert.equal(frozen.proof.retryUiObservation, frozenRecord); assert.deepEqual(frozenRecord, frozenBefore);
  assert.deepEqual(frozen.events, frozenEvents);
  for (const observedReady of [true, false]) {
    const mutatingProof = {};
    Object.defineProperty(mutatingProof, 'retryUiObservation', { set(value: { last: { ready: boolean } | null }) {
      if (value.last) value.last.ready = !observedReady;
    } });
    const altered = observe(observedReady ? [frame([button('Refresh')])] : [frame([], false), stop],
      { proof: mutatingProof });
    if (observedReady) await altered.done; else await assert.rejects(altered.done, error => error === stop);
    assert.equal(altered.counts.reads, observedReady ? 1 : 2);
    assert.equal(altered.counts.sends + altered.counts.steps, 0);
  }
  const accept = success.ready(); assert(accept);
  let getterReads = 0;
  const accessor = { ...ready };
  Object.defineProperty(accessor, 'ready', { get() { getterReads++; return true; } });
  const reflection = new Proxy({}, { getPrototypeOf() { throw stop; },
    getOwnPropertyDescriptor() { throw stop; } });
  for (const malformed of [undefined, null, true, [], {}, Object.create(ready), accessor, reflection,
    { toString() { return assert.fail('no result coercion'); } },
    { ...ready, refresh: 'TEST private invalid' }, { ...ready, ready: 'true' },
    { ...ready, surfacePresent: false }]) assert.equal(accept(malformed), false);
  assert.equal(getterReads, 0);
  assert.deepEqual(success.proof.retryUiObservation, expected(ready));
  for (let index = 0; index < 127; index++) assert.equal(accept(ready), true);
  assert.deepEqual(success.proof.retryUiObservation, expected(ready, 128, false, success.clocks(), 5));
  assert.equal(accept(ready), true);
  assert.deepEqual(success.proof.retryUiObservation, expected(ready, 128, true, success.clocks(), 5));
  const latestFalse = { ...ready, alertPresent: true, ready: false };
  assert.equal(accept(latestFalse), false);
  assert.deepEqual(success.proof.retryUiObservation, expected(latestFalse, 128, true, success.clocks(), 5));
  assert(Buffer.byteLength(JSON.stringify(success.proof.retryUiObservation), 'utf8') <= 512);
  const maximum = { ...expected({ ...ready, surfacePresent: false, refresh: 'not-observed',
    firstRefreshBusy: null, retryPresent: null, alertPresent: null, ready: false }, 128, false,
  Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), stages: {
    clickReturnedMs: Number.MAX_SAFE_INTEGER, writerObservedMs: Number.MAX_SAFE_INTEGER,
    hostCheckedMs: Number.MAX_SAFE_INTEGER, uiReadyMs: Number.MAX_SAFE_INTEGER } };
  assert(Buffer.byteLength(JSON.stringify(maximum), 'utf8') <= 512, 'the maximum-width valid canonical observation fits its byte bound');
  assert.deepEqual(success.counts, { waits: 1, reads: 1, guards: 1, remaining: 1, births: 1, sends: 0, steps: 0 });
});

test('Windows primary failure is emitted once before cleanup without replacing the original error', async () => {
  const source = (await readFile(new URL('../../tools/owned-process-broker/nativeWindowsAppGate.mjs', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  const start = '} catch (error) {\n  primaryError = error;\n  proof.error = errorText(error);\n';
  const end = '\n} finally {\n  if (app && !quitStarted) {';
  assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2);
  const from = source.indexOf(start) + '} catch (error) {\n'.length, to = source.indexOf(end, from);
  assert(to > from);
  const formatterStart = 'const errorText = ', formatterFrom = source.indexOf(formatterStart) + formatterStart.length;
  assert.equal(source.split(formatterStart).length, 2);
  const formatter = Function('return (' + source.slice(formatterFrom, source.indexOf(';\n', formatterFrom)) + ');')();
  const execute = Function('error', 'proof', 'errorText', 'writeSync', 'Buffer', 'activePhase', 'finish',
    '"use strict"; let primaryError; try {' + source.slice(from, to) + '\n} finally { finish(); } return primaryError;');
  const phase = 'one-explicit-same-Main-Retry';
  const exercise = (text: string, observation: unknown = null, sink: 'ok' | 'throw' | 'partial' = 'ok', activePhase = phase) => {
    let stackReads = 0, messageReads = 0, writes = 0, finished = 0;
    const error = new Error('TEST original error');
    Object.defineProperty(error, 'stack', { get() { stackReads++; return text; } });
    Object.defineProperty(error, 'message', { get() { messageReads++; throw new Error('TEST unexpected message read'); } });
    const proof: Record<string, unknown> = { retryUiObservation: observation };
    const lines: string[] = [];
    const result = execute(error, proof, formatter, (fd: number, line: string) => {
      assert.equal(fd, 1); writes++; if (sink === 'throw') throw new Error('TEST original stdout unavailable');
      lines.push(line); return sink === 'partial' ? 1 : Buffer.byteLength(line, 'utf8');
    }, Buffer, activePhase, () => { finished++; });
    assert.equal(result, error); assert.equal(proof.error, text.slice(0, 4000));
    assert.equal(stackReads, 1); assert.equal(messageReads, 0); assert.equal(finished, 1);
    return { proof, lines, writes };
  };
  const original = exercise('TEST original primary failure');
  assert.equal(original.writes, 1, 'the original primary catch must emit its retained failure before cleanup');
  assert.equal(original.lines.length, 1);
  assert.deepEqual(JSON.parse(original.lines[0]!), { kind: 'TEST_WINDOWS_PACKAGED_UI_FAILURE',
    phase, error: 'TEST original primary failure', errorTruncated: false, retryUiObservation: null });
  assert(original.lines[0]!.endsWith('\n'));
  const observation = { schemaVersion: 1, source: 'original-recovery-wait', atomicWithFailure: false,
    stages: { clickReturnedMs: 1, writerObservedMs: 2, hostCheckedMs: 3, uiReadyMs: null },
    sampleCount: 1, sampleCountCapped: false, lastAtMs: 4, last: { surfacePresent: true, refresh: 'disabled',
      firstRefreshBusy: true, retryPresent: null, alertPresent: null, ready: false } };
  const long = '\u{1f642}'.repeat(1600), retained = exercise(long, observation);
  const decoded = JSON.parse(retained.lines[0]!);
  assert.equal(decoded.error, long.slice(0, 1024)); assert.equal(decoded.errorTruncated, true);
  assert.deepEqual(decoded.retryUiObservation, observation);
  assert.equal(retained.proof.error, long); assert(Buffer.byteLength(retained.lines[0]!, 'utf8') <= 8192);
  const boundary = exercise('x'.repeat(1024));
  assert.equal(JSON.parse(boundary.lines[0]!).errorTruncated, false);
  const overflow = exercise('TEST original', { unexpected: 'x'.repeat(9000) });
  assert.equal(overflow.writes, 1);
  assert.equal(overflow.lines[0], '{"kind":"TEST_WINDOWS_PACKAGED_UI_FAILURE","reason":"projection-limit"}\n');
  const unwritable = exercise('TEST original', null, 'throw');
  assert.equal(unwritable.writes, 1); assert.deepEqual(unwritable.lines, []);
  const partial = exercise('TEST original', null, 'partial');
  assert.equal(partial.writes, 1); assert.equal(partial.lines.length, 1);
  const text = 'TEST byte boundary', overhead = Buffer.byteLength(JSON.stringify({
    kind: 'TEST_WINDOWS_PACKAGED_UI_FAILURE', phase: '', error: text, errorTruncated: false, retryUiObservation: null,
  }) + '\n', 'utf8');
  const atLimit = exercise(text, null, 'ok', 'A'.repeat(8192 - overhead));
  assert.equal(atLimit.writes, 1); assert.equal(Buffer.byteLength(atLimit.lines[0]!, 'utf8'), 8192);
  assert.equal(JSON.parse(atLimit.lines[0]!).error, text);
  const overLimit = exercise(text, null, 'ok', 'A'.repeat(8193 - overhead));
  const unicodeLimit = exercise(text, null, 'ok', '\u754c'.repeat(3000));
  for (const rejected of [overLimit, unicodeLimit]) {
    assert.equal(rejected.writes, 1);
    assert.equal(rejected.lines[0], '{"kind":"TEST_WINDOWS_PACKAGED_UI_FAILURE","reason":"projection-limit"}\n');
  }
  const projectionFailure = exercise('TEST original', { toJSON() { throw new Error('TEST projection failed'); } });
  assert.equal(projectionFailure.writes, 0);
  const formatterFailure = new Error('TEST original formatter failed'), error = new Error('TEST original');
  Object.defineProperty(error, 'stack', { get() { throw formatterFailure; } });
  let writes = 0, finished = 0;
  assert.throws(() => execute(error, {}, formatter, () => { writes++; }, Buffer, phase,
    () => { finished++; }), value => value === formatterFailure);
  assert.equal(writes, 0); assert.equal(finished, 1);
});

test('Windows final Retry requires both complete original rows in one current sample', { timeout: 5000 }, async () => {
  const source = (await readFile(new URL('../../tools/owned-process-broker/nativeWindowsAppGate.mjs', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  const start = '  proof.afterRetryPublic = await readProcesses();\n';
  const end = '  proof.sameMainAfterRetry = captureCensus().find(row => row.pid === main.pid);';
  assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2);
  const from = source.indexOf(start) + start.length, to = source.indexOf(end, from); assert(to > from);
  const compile = (block: string) => Function('assert', 'ui', 'original', 'processOwner', 'remaining', 'object',
    'return (async () => {' + block + '\n})();');
  const execute = compile(source.slice(from, to));
  const oldSequential = compile("  for (const row of original.rows) {\n" +
    "    const owner = object(await ui.waitRead(processOwner(row), 'same original process refs after Retry', remaining()));\n" +
    "    assert.deepEqual(owner.process, { ...row, observation: 'same-live', canTerminate: true });\n  }\n");
  const selectedStart = 'const processOwner = (row, stopped = false) =>';
  const selectedEnd = '\nconst readProcesses = async () => {';
  assert.equal(source.split(selectedStart).length, 2); assert.equal(source.split(selectedEnd).length, 2);
  const selectedFrom = source.indexOf(selectedStart), selectedTo = source.indexOf(selectedEnd, selectedFrom);
  assert(selectedTo > selectedFrom);
  const selectedTeam = 'TEST-original-owner-qualified-team';
  const processOwner = Function('desktopProcessOwnerExpression', 'selection',
    source.slice(selectedFrom, selectedTo) + '\nreturn processOwner;')(desktopProcessOwnerExpression, selectedTeam);
  const rows = Object.freeze([Object.freeze({ ...wireOriginal }), Object.freeze({ ...wireNeighbor })]);
  const liveRows = rows.map(row => ({ ...row, observation: 'same-live', canTerminate: true }));
  const object = (value: unknown) => {
    assert(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
  };
  const frame = (processes: Record<string, unknown>[], teamName = selectedTeam) => ({ processes, teamName });
  const unavailable = new Error('TEST final-row sample unavailable');
  const observe = (frames: (ReturnType<typeof frame> | Error)[], options: {
    execute?: typeof execute; guardError?: Error; remainingError?: Error;
    forcedResult?: { value: unknown }; late?: boolean;
  } = {}) => {
    const counts = { waits: 0, reads: 0, guards: 0, remaining: 0, sends: 0, steps: 0 };
    const comparisons: { actual: unknown; expected: unknown }[] = [];
    const controls = createDesktopUiControls({
      async evaluate(expression: string): Promise<unknown> {
        const current = frames[counts.reads++];
        if (!current) throw unavailable;
        if (current instanceof Error) throw current;
        if (options.late) await delay(60);
        const section = { querySelectorAll: () => [],
          __reactFiber$TEST: { memoizedProps: { ...current, isTeamAlive: false }, alternate: null, return: null } };
        const document = { querySelector(selector: string) {
          assert.equal(selector, '[data-section-id="processes"]'); return section;
        } };
        return Function('document', 'return ' + expression)(document);
      },
      async send() { counts.sends++; return assert.fail('TEST final-row observation sends no input'); },
    }, {
      assertOwnedRenderer() { counts.guards++; if (options.guardError) throw options.guardError; },
      step() { counts.steps++; },
    });
    const budget = options.late ? 30 : 2000;
    const checkedAssert = { ok: assert.ok, equal: assert.equal, deepEqual(actual: unknown, expected: unknown) {
      comparisons.push({ actual, expected }); assert.deepEqual(actual, expected);
    } };
    return {
      run: () => (options.execute ?? execute)(checkedAssert, {
        waitRead(expression: string, label: string, actualBudget: number) {
          counts.waits++; assert.equal(label, 'same original process refs after Retry');
          assert.equal(actualBudget, budget);
          // Consumer-boundary fault injection; the healthy expression does not return these payloads.
          if (options.forcedResult) return Promise.resolve(options.forcedResult.value);
          return controls.waitRead(expression, label, actualBudget);
        },
      }, { rows }, processOwner, () => {
        counts.remaining++; if (options.remainingError) throw options.remainingError; return budget;
      }, object),
      counts, comparisons,
    };
  };
  const split = [frame([liveRows[0]!]), frame([liveRows[1]!])];
  const old = observe(split, { execute: oldSequential }); await old.run();
  assert.deepEqual(old.counts, { waits: 2, reads: 2, guards: 2, remaining: 2, sends: 0, steps: 0 });
  assert.equal(old.comparisons.length, 2, 'the old loop really accepts disjoint samples with full row assertions');
  const separate = observe(split);
  await assert.rejects(separate.run(), error => error === unavailable);
  assert.deepEqual(separate.counts, { waits: 1, reads: 3, guards: 3, remaining: 1, sends: 0, steps: 0 });
  assert.deepEqual(separate.comparisons, []);
  const together = observe([frame(liveRows)]); await together.run();
  assert.deepEqual(together.counts, { waits: 1, reads: 1, guards: 1, remaining: 1, sends: 0, steps: 0 });
  assert.deepEqual(together.comparisons, rows.map((row, index) => ({
    actual: liveRows[index], expected: { ...row, observation: 'same-live', canTerminate: true },
  })));
  const laterTogether = observe([...split, frame(liveRows)]); await laterTogether.run();
  assert.deepEqual(laterTogether.counts, { waits: 1, reads: 3, guards: 3, remaining: 1, sends: 0, steps: 0 });
  assert.deepEqual(laterTogether.comparisons, together.comparisons);
  for (const invalid of [
    frame(liveRows, 'TEST-foreign-owner-qualified-team'),
    frame([{ ...liveRows[0]!, id: 'TEST-wrong-id' }, liveRows[1]!]),
    frame([{ ...liveRows[0]!, processRef: 'TEST-replacement-ref' }, liveRows[1]!]),
    frame([liveRows[0]!, { ...liveRows[1]!, processRef: 'TEST-replacement-neighbor-ref' }]),
    frame([liveRows[0]!, liveRows[0]!, liveRows[1]!]),
    frame([liveRows[0]!, liveRows[1]!, liveRows[1]!]),
    frame([]),
  ]) await assert.rejects(observe([invalid]).run(), error => error === unavailable);
  for (const change of [
    { pid: 789 }, { label: 'TEST changed neighbor' }, { registeredAt: '2026-10-30T00:00:00Z' },
    { observation: 'absent' }, { canTerminate: false },
  ]) {
    const changed = observe([frame([liveRows[0]!, { ...liveRows[1]!, ...change }])]);
    await assert.rejects(changed.run(), { code: 'ERR_ASSERTION' });
    assert.equal(changed.comparisons.length, 2);
    assert.deepEqual(changed.comparisons[0], together.comparisons[0]);
    assert.deepEqual(changed.comparisons[1]!.expected, together.comparisons[1]!.expected);
  }
  const guard = new Error('TEST original owner changed'), cutoff = new Error('TEST original phase expired');
  const blocked = observe([frame(liveRows)], { guardError: guard });
  await assert.rejects(blocked.run(), error => error === guard);
  assert.deepEqual(blocked.counts, { waits: 1, reads: 0, guards: 1, remaining: 1, sends: 0, steps: 0 });
  const expired = observe([frame(liveRows)], { remainingError: cutoff });
  await assert.rejects(expired.run(), error => error === cutoff);
  assert.deepEqual(expired.counts, { waits: 0, reads: 0, guards: 0, remaining: 1, sends: 0, steps: 0 });
  const evaluation = new Error('TEST final renderer evaluation failed');
  await assert.rejects(observe([evaluation]).run(), error => error === evaluation);
  const late = observe([frame(liveRows)], { late: true });
  await assert.rejects(late.run(), /UI read timed out: same original process refs after Retry; no mutation retry/u);
  assert.deepEqual(late.comparisons, [], 'a ready pair returned after the original wait cutoff is not consumed');
  assert.deepEqual(late.counts, { waits: 1, reads: 1, guards: 1, remaining: 1, sends: 0, steps: 0 });
  const owners = liveRows.map(process => ({ process }));
  for (const value of [null, {}, [], [owners[0]], [...owners, owners[0]], [owners[0], null],
    [owners[0], []], [owners[0], {}], [owners[0], { process: null }]]) {
    await assert.rejects(observe([], { forcedResult: { value } }).run(), { code: 'ERR_ASSERTION' });
  }
});
