import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { Server } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { createRuntimeMemberProviderFactory } from '../dist/composition/createRuntimeMemberProviderFactory.js';
import { createTeamHost } from '../dist/composition/TeamHost.js';
import { beginModelReadinessAuthorityTiming, createModelReadinessTiming } from '../dist/diagnostics/modelReadinessTiming.js';
import { RuntimeOwnerError } from '../dist/runtime/contracts.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';

import type { MemberProvider, MemberProviderContext } from '../dist/adapters/providers/MemberProvider.js';
import type { MemberEntry } from '../dist/composition/MemberEntry.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { ModelReadinessAuthorityTiming } from '../dist/diagnostics/modelReadinessTiming.js';
import type { RuntimeBinding } from '../dist/runtime/contracts.js';
import type { DriverFactory, OpenConfig, Session } from '@agent-teams/provider-session-contracts';
import type { TestContext } from 'node:test';

const diagnosticPrefix = 'legacy-agent-host: runtime-open ';

function factoryAccountGuard(context: Record<string, unknown>): () => void {
  const source = readFileSync(new URL('../src/composition/createRuntimeMemberProviderFactory.ts', import.meta.url), 'utf8');
  const begin = '          const assertCurrent = () => {\n';
  const end = '\n          return consumeMemberModelReadiness(';
  assert.equal(source.split(begin).length, 2); assert.equal(source.split(end).length, 2);
  const program = source.slice(source.indexOf(begin), source.indexOf(end)) + '\nassertCurrent;';
  return runInNewContext(stripTypeScriptTypes(program), {
    beginModelReadinessAuthorityTiming, RuntimeOwnerError, defaultAllocation: undefined, ...context,
  }) as () => void;
}

test('original factory account checks preserve order and exact errors through passive observer failures', () => {
  for (const refusal of ['none', 'first-capture', 'provider', 'allocation', 'last-capture']) {
    for (const observer of ['none', 'getter-throw', 'begin-throw', 'end-throw', 'observed']) {
      const calls: string[] = [], observations: string[] = [], original = Error('TEST original authority failure');
      const sink: ModelReadinessAuthorityTiming = {};
      if (observer === 'getter-throw') Object.defineProperty(sink, 'observe', { get() { throw Error('TEST observer getter'); } });
      else if (observer !== 'none') sink.observe = function (part) {
        assert.equal(arguments.length, 1, 'no executable authority callback crosses the observation seam');
        observations.push('begin-' + part);
        if (observer === 'begin-throw') throw Error('TEST observer begin');
        return () => { observations.push('end-' + part); if (observer === 'end-throw') throw Error('TEST observer end'); };
      };
      let captures = 0;
      const current = factoryAccountGuard({
        authorityTiming: sink,
        assertCaptured() {
          const phase = ++captures === 1 ? 'first-capture' : 'last-capture';
          calls.push(phase); if (refusal === phase) throw original;
        },
        authority: { assertCurrent() {
          assert.equal(arguments.length, 0, 'generic authority has no inherited-fence continuation');
          calls.push('provider'); if (refusal === 'provider') throw original;
        } },
        assertAllocation() { calls.push('allocation'); if (refusal === 'allocation') throw original; },
      });
      if (refusal === 'none') assert.doesNotThrow(current);
      else assert.throws(current, error => error === original);
      const expected = ['first-capture', 'provider', 'allocation', 'last-capture'];
      assert.deepEqual(calls, refusal === 'none' ? expected : expected.slice(0, expected.indexOf(refusal) + 1));
      if (observer === 'observed' || observer === 'end-throw') {
        assert.deepEqual(observations, calls.filter(part => part === 'provider' || part === 'allocation')
          .flatMap(part => ['begin-' + part, 'end-' + part]), 'throwing original calls still finish their partial interval');
      }
    }
  }
});

test('original factory shares only the successful provider continuation and preserves every refusal through observer failures', () => {
  const owner = {}, selectedBinding = { memberId: 'TEST-original-member' };
  for (const refusal of ['none', 'first-capture', 'provider', 'continuation', 'allocation', 'release', 'last-capture']) {
    for (const observer of ['none', 'getter-throw', 'begin-throw', 'end-throw', 'observed']) {
      const calls: string[] = [], observations: string[] = [], original = Error('TEST exact original failure');
      const providerFinishes: { lastCall: string | undefined; nestedAllocationMs: number | undefined }[] = [];
      const sink: ModelReadinessAuthorityTiming = {};
      if (observer === 'getter-throw') Object.defineProperty(sink, 'observe', { get() { throw Error('TEST getter'); } });
      else if (observer !== 'none') sink.observe = part => {
        observations.push('begin-' + part);
        if (observer === 'begin-throw') throw Error('TEST begin');
        return deduction => {
          observations.push('end-' + part);
          if (part === 'provider' && calls.includes('continuation'))
            providerFinishes.push({ lastCall: calls.at(-1), nestedAllocationMs: deduction?.nestedAllocationMs });
          if (observer === 'end-throw') throw Error('TEST end');
          return part === 'allocation' ? 5 : 10;
        };
      };
      let captures = 0, laterActions = 0;
      const assertAllocation = () => { calls.push('allocation'); if (refusal === 'allocation') throw original; };
      const current = factoryAccountGuard({
        authorityTiming: sink,
        assertCaptured() {
          const phase = ++captures === 1 ? 'first-capture' : 'last-capture';
          calls.push(phase); if (refusal === phase) throw original;
        },
        authority: { assertCurrent(onCurrent: (owner: object, binding: object) => void) {
          assert.equal(arguments.length, 1);
          calls.push('provider'); if (refusal === 'provider') throw original;
          let failed = false, failure: unknown;
          try { onCurrent(owner, selectedBinding); } catch (error) { failed = true; failure = error; }
          calls.push('release');
          if (refusal === 'release') throw original;
          if (failed) throw failure;
        } },
        defaultAllocation(actualOwner: object, actualBinding: object) {
          calls.push('continuation');
          assert.equal(actualOwner, owner); assert.equal(actualBinding, selectedBinding);
          if (refusal === 'continuation') throw original;
          assertAllocation();
        },
        assertAllocation,
      });
      const action = () => { current(); laterActions++; };
      if (refusal === 'none') assert.doesNotThrow(action);
      else assert.throws(action, error => error === original);
      const expected = ['first-capture', 'provider', 'continuation', 'allocation', 'release', 'last-capture'];
      const stopped = refusal === 'none' ? expected : expected.slice(0, expected.indexOf(refusal) + 1);
      if (refusal === 'continuation' || refusal === 'allocation') stopped.push('release');
      assert.deepEqual(calls, stopped, 'no ordinary allocation retry follows a shared refusal or failed unlock');
      assert.equal(laterActions, refusal === 'none' ? 1 : 0);
      if (observer === 'observed' || observer === 'end-throw') {
        const observed = calls.includes('provider') ? ['begin-provider'] : [];
        if (calls.includes('continuation')) observed.push('begin-allocation', 'end-allocation');
        if (calls.includes('provider')) observed.push('end-provider');
        assert.deepEqual(observations, observed, 'each throwing partial interval settles exactly once');
        assert.deepEqual(providerFinishes, calls.includes('continuation')
          ? [{ lastCall: 'release', nestedAllocationMs: observer === 'observed' ? 5 : undefined }] : [],
          'shared release precedes provider finish and only the measured allocation interval is deducted');
      }
    }
  }
});

test('original factory fallback stays outside the provider fence and rejects duplicate or late continuations', () => {
  const owner = {}, selectedBinding = {};
  for (const mode of ['fallback', 'duplicate', 'late', 'fallback-error']) {
    const calls: string[] = [], observations: string[] = [], original = Error('TEST fallback refusal');
    let retained: ((owner: object, binding: object) => void) | undefined, released = false;
    const current = factoryAccountGuard({
      authorityTiming: { observe(part: string) {
        observations.push('begin-' + part);
        return (deduction?: { nestedAllocationMs: number | undefined }) => {
          observations.push('end-' + part + (deduction ? '-nested' : ''));
          return 1;
        };
      } },
      assertCaptured() { calls.push('capture'); },
      authority: { assertCurrent(onCurrent: (owner: object, binding: object) => void) {
        calls.push('provider'); retained = onCurrent;
        try {
          if (mode === 'duplicate') { onCurrent(owner, selectedBinding); onCurrent(owner, selectedBinding); }
        } finally { released = true; calls.push('release'); }
        if (mode === 'fallback' || mode === 'fallback-error') {
          calls.push('legacy-fallback');
          if (mode === 'fallback-error') throw original;
        }
      } },
      defaultAllocation() { assert.equal(released, false); calls.push('inherited-allocation'); },
      assertAllocation() { assert.equal(released, true); calls.push('ordinary-allocation'); },
    });
    if (mode === 'duplicate') {
      assert.throws(current, { code: 'forbidden' });
      assert.deepEqual(calls, ['capture', 'provider', 'inherited-allocation', 'release']);
    } else if (mode === 'fallback-error') {
      assert.throws(current, error => error === original);
      assert.deepEqual(calls, ['capture', 'provider', 'release', 'legacy-fallback']);
    } else {
      current();
      assert.deepEqual(calls, ['capture', 'provider', 'release',
        ...(mode === 'fallback' ? ['legacy-fallback'] : []), 'ordinary-allocation', 'capture']);
    }
    assert.deepEqual(observations, mode === 'duplicate'
      ? ['begin-provider', 'begin-allocation', 'end-allocation', 'end-provider-nested']
      : mode === 'fallback-error' ? ['begin-provider', 'end-provider']
        : ['begin-provider', 'end-provider', 'begin-allocation', 'end-allocation']);
    const beforeLate = [...calls], beforeLateTiming = [...observations];
    assert.ok(retained);
    assert.throws(() => retained!(owner, selectedBinding), { code: 'forbidden' });
    assert.deepEqual(calls, beforeLate, 'retained continuation cannot execute after the original synchronous call');
    assert.deepEqual(observations, beforeLateTiming, 'late continuation cannot open another diagnostic interval');
  }
});

test('account timing restores synchronous nested observers and retains throwing partial intervals', t => {
  let now = 0, clockReads = 0;
  t.mock.method(performance, 'now', () => { clockReads++; return now; });
  const subscriber = { hasSubscribers: true }, timing = createModelReadinessTiming(subscriber);
  const previous = () => { assert.fail('the replaced observer is not called'); };
  const sink: ModelReadinessAuthorityTiming = { observe: previous };
  const originalDescriptor = Object.getOwnPropertyDescriptor(sink, 'observe');
  const outer = timing.begin(true, sink);
  assert.equal(sink.observe, previous, 'activation does not precede the original account interval');
  const endOuterAccount = outer.beginAccount!(), outerObserver = sink.observe;
  const endProvider = beginModelReadinessAuthorityTiming(sink, 'provider'); now += 2;
  const original = Error('TEST nested original allocation failure');
  assert.throws(() => {
    const inner = timing.begin(true, sink), endInnerAccount = inner.beginAccount!();
    assert.notEqual(sink.observe, outerObserver);
    try {
      const endAllocation = beginModelReadinessAuthorityTiming(sink, 'allocation');
      try { now += 5; throw original; } finally { endAllocation?.(); }
    } finally { endInnerAccount(); inner.finish(); }
  }, error => error === original);
  assert.equal(sink.observe, outerObserver, 'the nested finally restores the still-active outer interval');
  endProvider?.();
  const endAllocation = beginModelReadinessAuthorityTiming(sink, 'allocation'); now += 3; endAllocation?.();
  endOuterAccount(); outer.finish();
  assert.deepEqual(Object.getOwnPropertyDescriptor(sink, 'observe'), originalDescriptor);
  const result = timing.snapshot(); assert.equal(result.count, 2); assert.equal(result.truncated, false);
  assert.equal(result.regions!.referenceAccountProviderCount, 1);
  assert.equal(result.regions!.referenceAccountProviderMs, 7);
  assert.equal(result.regions!.referenceAccountAllocationCount, 2);
  assert.equal(result.regions!.referenceAccountAllocationMs, 8);
  const previousReads = clockReads;
  const afterRefusal = timing.begin(false, sink); afterRefusal.beginAccountAuthority()(); afterRefusal.finish();
  subscriber.hasSubscribers = false;
  const disabled = timing.begin(true, sink); disabled.beginAccountAuthority()(); disabled.finish();
  assert.equal(afterRefusal.beginAccount, undefined); assert.equal(disabled.beginAccount, undefined);
  assert.equal(clockReads, previousReads, 'no subscriber or a latched refusal adds no diagnostic clocks');
  assert.deepEqual(Object.getOwnPropertyDescriptor(sink, 'observe'), originalDescriptor);
});

test('shared account timing stays exclusive, includes final release in Provider and uses only four pair clocks', t => {
  let now = 0, clocks = 0;
  t.mock.method(performance, 'now', () => { clocks++; return now; });
  const subscriber = { hasSubscribers: true }, timing = createModelReadinessTiming(subscriber);
  const sink: ModelReadinessAuthorityTiming = {};
  const sample = timing.begin(true, sink), endAccount = sample.beginAccount!();
  const endAuthority = sample.beginAccountAuthority(), beforePair = clocks;
  const endProvider = beginModelReadinessAuthorityTiming(sink, 'provider'); now += 2;
  const endAllocation = beginModelReadinessAuthorityTiming(sink, 'allocation'); now += 5;
  const allocationMs = endAllocation?.();
  assert.equal(allocationMs, 5);
  now += 3; // The original shared fence releases after allocation, before Provider finishes.
  assert.equal(endProvider?.({ nestedAllocationMs: allocationMs }), 10, 'finish returns raw enclosing duration');
  assert.equal(clocks - beforePair, 4);
  endAuthority(); endAccount(); sample.finish();
  const result = timing.snapshot();
  assert.equal(result.truncated, false);
  assert.equal(result.regions!.referenceAccountProviderCount, 1);
  assert.equal(result.regions!.referenceAccountProviderMs, 5);
  assert.equal(result.regions!.referenceAccountAllocationCount, 1);
  assert.equal(result.regions!.referenceAccountAllocationMs, 5);
  assert.equal(result.regions!.referenceAccountAuthorityMs, 10);
  assert.equal(Object.hasOwn(sink, 'observe'), false);
  subscriber.hasSubscribers = false;
  const beforeDisabled = clocks, disabled = timing.begin(true, sink);
  const disabledProvider = beginModelReadinessAuthorityTiming(sink, 'provider');
  const disabledAllocation = beginModelReadinessAuthorityTiming(sink, 'allocation');
  disabledProvider?.({ nestedAllocationMs: disabledAllocation?.() }); disabled.finish();
  assert.equal(clocks, beforeDisabled, 'disabled nested timing introduces no clocks');
});

test('shared account timing rounds accumulated raw exclusive intervals once per original account sample', t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const timing = createModelReadinessTiming({ hasSubscribers: true }), sink: ModelReadinessAuthorityTiming = {};
  const sample = timing.begin(true, sink), endAccount = sample.beginAccount!();
  for (let pair = 0; pair < 2; pair++) {
    const endProvider = beginModelReadinessAuthorityTiming(sink, 'provider'); now += 0.3;
    const endAllocation = beginModelReadinessAuthorityTiming(sink, 'allocation'); now += 0.6;
    const allocationMs = endAllocation?.(); now += 0.3;
    endProvider?.({ nestedAllocationMs: allocationMs });
  }
  endAccount(); sample.finish();
  const result = timing.snapshot();
  assert.equal(result.truncated, false);
  assert.equal(result.regions!.referenceAccountProviderCount, 1);
  assert.equal(result.regions!.referenceAccountProviderMs, 1);
  assert.equal(result.regions!.referenceAccountAllocationCount, 1);
  assert.equal(result.regions!.referenceAccountAllocationMs, 1);
});

test('shared account timing omits an invalid enclosing sample without clamping or hiding allocation observations', t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  for (const nestedAllocationMs of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, 11]) {
    now = 0;
    const timing = createModelReadinessTiming({ hasSubscribers: true }), sink: ModelReadinessAuthorityTiming = {};
    const sample = timing.begin(true, sink), endAccount = sample.beginAccount!();
    const endProvider = beginModelReadinessAuthorityTiming(sink, 'provider'); now = 2;
    const endAllocation = beginModelReadinessAuthorityTiming(sink, 'allocation'); now = 7;
    assert.equal(endAllocation?.(), 5); now = 10;
    assert.doesNotThrow(() => endProvider?.({ nestedAllocationMs }));
    endAccount(); sample.finish();
    const result = timing.snapshot();
    assert.equal(result.truncated, true);
    assert.equal(result.regions!.referenceAccountProviderCount, 0);
    assert.equal(result.regions!.referenceAccountProviderMs, 0);
    assert.equal(result.regions!.referenceAccountAllocationCount, 1);
    assert.equal(result.regions!.referenceAccountAllocationMs, 5);
    assert.equal(result.regions!.referenceAccountMs, 10);
    assert.equal(Object.hasOwn(sink, 'observe'), false);
  }
});

test('shared exclusive timing keeps each reentrant account duration and restores the original observer', t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const timing = createModelReadinessTiming({ hasSubscribers: true });
  const previous = () => undefined, sink: ModelReadinessAuthorityTiming = { observe: previous };
  const descriptor = Object.getOwnPropertyDescriptor(sink, 'observe');
  const outer = timing.begin(true, sink), endOuterAccount = outer.beginAccount!(), outerObserver = sink.observe;
  const endOuterProvider = beginModelReadinessAuthorityTiming(sink, 'provider'); now = 2;
  const endOuterAllocation = beginModelReadinessAuthorityTiming(sink, 'allocation'); now = 3;
  const inner = timing.begin(true, sink), endInnerAccount = inner.beginAccount!();
  const endInnerProvider = beginModelReadinessAuthorityTiming(sink, 'provider'); now = 5;
  const endInnerAllocation = beginModelReadinessAuthorityTiming(sink, 'allocation'); now = 8;
  const innerAllocationMs = endInnerAllocation?.(); now = 9;
  endInnerProvider?.({ nestedAllocationMs: innerAllocationMs }); endInnerAccount(); inner.finish();
  assert.equal(sink.observe, outerObserver);
  now = 10;
  const outerAllocationMs = endOuterAllocation?.(); now = 14;
  assert.equal(innerAllocationMs, 3); assert.equal(outerAllocationMs, 8);
  endOuterProvider?.({ nestedAllocationMs: outerAllocationMs }); endOuterAccount(); outer.finish();
  assert.deepEqual(Object.getOwnPropertyDescriptor(sink, 'observe'), descriptor);
  const result = timing.snapshot();
  assert.equal(result.truncated, false); assert.equal(result.count, 2);
  assert.equal(result.regions!.referenceAccountProviderCount, 2);
  assert.equal(result.regions!.referenceAccountProviderMs, 9);
  assert.equal(result.regions!.referenceAccountAllocationCount, 2);
  assert.equal(result.regions!.referenceAccountAllocationMs, 11);
});

test('account timing preserves the original 4096 interval bound and ignores sink setup failure', t => {
  let clocks = 0;
  t.mock.method(performance, 'now', () => { clocks++; return 0; });
  const timing = createModelReadinessTiming({ hasSubscribers: true });
  for (let count = 0; count < 4096; count++) { const sample = timing.begin(true); sample.finish(); }
  assert.equal(clocks, 8192);
  const overflow = timing.begin(true, {}); overflow.beginAccountAuthority()(); overflow.finish();
  assert.equal(overflow.beginAccount, undefined); assert.equal(clocks, 8192);
  assert.equal(timing.snapshot().count, 4096); assert.equal(timing.snapshot().lastMs, null);
  assert.equal(timing.snapshot().truncated, true);
  const broken = createModelReadinessTiming({ hasSubscribers: true });
  const sample = broken.begin(true, Object.freeze({})), endAccount = sample.beginAccount!();
  assert.doesNotThrow(endAccount); assert.doesNotThrow(sample.finish);
  assert.equal(broken.snapshot().truncated, true);
  assert.equal(broken.snapshot().regions!.referenceAccountCount, 1);
});

test('original refusal emitter and collector allow only paired bounded authority timing keys', () => {
  const profile = readFileSync(new URL('../../../tools/owned-process-broker/nativeEmulatedSourceProfile.ts', import.meta.url), 'utf8');
  const reader = readFileSync(new URL('../../../tools/owned-process-broker/nativeEmulatedSourceReadiness.ts', import.meta.url), 'utf8');
  const emitterStart = 'function validateSourceRefusal(value, persisted) {';
  const emitterEnd = '\nconst ledger = ${JSON.stringify(refusals)}';
  const readerStart = 'export function validateEmulatedSourceRefusal(';
  const readerEnd = '\n/** Join only the already-read original refusal records';
  for (const [source, begin, end] of [[profile, emitterStart, emitterEnd], [reader, readerStart, readerEnd]]) {
    assert.equal(source!.split(begin!).length, 2); assert.equal(source!.split(end!).length, 2);
  }
  const sourceRecord = reader.slice(reader.indexOf('const sourceRecord ='), reader.indexOf('export const unwrapEmulatedSourceResult'));
  const programs = [profile.slice(profile.indexOf(emitterStart), profile.indexOf(emitterEnd)),
    stripTypeScriptTypes(sourceRecord + reader.slice(reader.indexOf(readerStart), reader.indexOf(readerEnd)).replace('export function', 'function'))];
  const regions = { initialAuthorityCount: 1, initialAuthorityMs: 1, readConsumerCount: 1, readConsumerMs: 0,
    referenceCount: 1, referenceMs: 6, finalAuthorityCount: 1, finalAuthorityMs: 1,
    referenceAccountCount: 1, referenceAccountMs: 6, referenceAccountAuthorityCount: 1, referenceAccountAuthorityMs: 5,
    referenceAccountProviderCount: 1, referenceAccountProviderMs: 2, referenceAccountAllocationCount: 1, referenceAccountAllocationMs: 3 };
  const make = () => ({ kind: 'consumer', actionDigest: 'a'.repeat(64), groupDigest: 'b'.repeat(64),
    bindingDigest: 'c'.repeat(64), consumerId: 'd'.repeat(64), phase: 'reference', reason: 'threw', cutoff: null, observedAt: null,
    currentCalls: { count: 1, totalMs: 8, maxMs: 8, lastMs: 8, truncated: false, regions: { ...regions } as Record<string, number> } });
  const optional = ['referenceAccountProviderCount', 'referenceAccountProviderMs', 'referenceAccountAllocationCount', 'referenceAccountAllocationMs'];
  for (const [index, program] of programs.entries()) {
    const name = index === 0 ? 'validateSourceRefusal' : 'validateEmulatedSourceRefusal';
    const validate = runInNewContext(program + '\n(raw, persisted) => ' + name + '(JSON.parse(raw), persisted);', { assert }) as (raw: string, persisted: boolean) => void;
    assert.doesNotThrow(() => validate(JSON.stringify(make()), false));
    assert.doesNotThrow(() => validate(JSON.stringify({ ...make(), ordinal: 1 }), true));
    const old = make(); for (const key of optional) delete old.currentCalls.regions[key];
    assert.doesNotThrow(() => validate(JSON.stringify(old), false), 'the old exact timing shape remains valid');
    for (const key of optional) {
      const partial = make(); delete partial.currentCalls.regions[key];
      assert.throws(() => validate(JSON.stringify(partial), false), { code: 'ERR_ASSERTION' });
    }
    for (const [key, value] of [['referenceAccountProviderCount', 2], ['referenceAccountAllocationMs', -1],
      ['referenceAccountUnknownCount', 0], ['referenceAccountUnknownMs', 0]] as const) {
      const unknown = make(); unknown.currentCalls.regions[key] = value;
      assert.throws(() => validate(JSON.stringify(unknown), false), { code: 'ERR_ASSERTION' });
    }
    const orphan = make(); delete orphan.currentCalls.regions.referenceAccountCount;
    delete orphan.currentCalls.regions.referenceAccountMs; delete orphan.currentCalls.regions.referenceAccountAuthorityCount;
    delete orphan.currentCalls.regions.referenceAccountAuthorityMs;
    assert.throws(() => validate(JSON.stringify(orphan), false), { code: 'ERR_ASSERTION' });
    const overflow = make(); overflow.currentCalls.count = 4097;
    assert.throws(() => validate(JSON.stringify(overflow), false), { code: 'ERR_ASSERTION' });
  }
});

const binding: RuntimeBinding = {
  backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-run',
  memberId: 'alice-id', generation: '1',
};
const config: OpenConfig = {
  tenantId: 'TEST-backend', projectId: 'TEST-project', sessionId: 'TEST-private-session',
  generation: 1, configRevision: 'TEST-private-revision', requiredCapabilities: ['tools'],
};
function capture(t: TestContext, event?: (record: Record<string, unknown>) => void) {
  const records: Record<string, unknown>[] = [];
  const original = process.stderr.write;
  t.mock.method(process.stderr, 'write', function (
    this: NodeJS.WriteStream, ...args: Parameters<NodeJS.WriteStream['write']>
  ) {
    const text = Buffer.isBuffer(args[0]) ? args[0].toString('utf8') : String(args[0]);
    if (!text.startsWith(diagnosticPrefix)) return original.apply(this, args);
    const record = JSON.parse(text.slice(diagnosticPrefix.length)) as Record<string, unknown>;
    records.push(record);
    event?.(record);
    const callback = args.find(value => typeof value === 'function');
    if (typeof callback === 'function') callback();
    return true;
  });
  return records;
}
function session(beforeReadiness?: () => void): Session {
  let end!: () => void;
  const ended = new Promise<void>(resolve => { end = resolve; });
  const driver: Session = {
    sessionRef: 'TEST-private-native-session',
    submit: async () => ({ ok: false, code: 'unsupported' }),
    observe: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => { await ended; return { done: true, value: undefined }; },
      }),
    }),
    respondToInteraction: async () => ({ ok: false, code: 'unsupported' }),
    interrupt: async () => ({ ok: false, code: 'unsupported' }),
    checkReadiness: async function () {
      assert.equal(this, driver);
      beforeReadiness?.();
      return { ok: true, value: undefined };
    },
    checkpoint: () => ({ ok: false, code: 'unsupported' }),
    close: async function () {
      assert.equal(this, driver);
      end();
      return { logicallyClosed: true, cleanup: 'confirmed' };
    },
  };
  return driver;
}
async function owner(t: TestContext, factory: DriverFactory) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-runtime-open-diagnostic-')));
  const runtime = new RuntimeOwner({
    store: new FileRuntimeStore(root), driverFactory: factory, profileId: 'TEST-private-profile',
    hostIncarnation: 'TEST-host', authorize: () => true,
  });
  t.after(async () => {
    await runtime.stopSession(binding);
    await rm(root, { recursive: true, force: true });
  });
  return runtime;
}

test('actual Runtime keeps a failed finite driver open held with the original configuration', async t => {
  const records = capture(t), original = new RuntimeOwnerError('forbidden');
  let calls = 0;
  const factory: DriverFactory = { open: async function () {
    assert.equal(this, factory); calls++; throw original;
  } };
  const runtime = await owner(t, factory);
  const record = await runtime.openSession({ binding, config });
  assert.equal(calls, 1);
  assert.equal(record.phase, 'held'); assert.equal(record.custody, 'unknown');
  assert.equal(record.nativeReady, false); assert.equal(record.diagnostic, 'open-unknown');
  assert.deepEqual(record.config, config);
  assert.equal(runtime.readCapturedSession(binding).attached, false);
  assert.equal(records.length, 1);
  assert.deepEqual(
    { source: records[0]!.source, phase: records[0]!.phase, category: records[0]!.category },
    { source: 'runtime', phase: 'driver-open', category: 'forbidden' }
  );
  assert.equal(records[0]!.configurationHash, runtimeDigest(config));
  assert.equal(JSON.stringify(records).includes(config.sessionId), false);
});

test('actual Runtime distinguishes a readiness throw after the finite driver was attached', async t => {
  const records = capture(t);
  const driver = session(() => { throw new RuntimeOwnerError('busy'); });
  const runtime = await owner(t, { open: async () => ({ driver, capabilities: ['tools'] }) });
  const record = await runtime.openSession({ binding, config });
  assert.equal(record.phase, 'held'); assert.equal(record.custody, 'unknown');
  assert.equal(record.nativeReady, false); assert.equal(record.diagnostic, 'open-unknown');
  assert.equal(runtime.readCapturedSession(binding).attached, true);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.phase, 'readiness'); assert.equal(records[0]!.category, 'busy');
});

test('actual Runtime success and its original finite close emit no refusal', async t => {
  const records = capture(t), driver = session();
  const runtime = await owner(t, { open: async () => ({ driver, capabilities: ['tools'] }) });
  const record = await runtime.openSession({ binding, config });
  assert.equal(record.phase, 'allocated'); assert.equal(record.nativeReady, true);
  const closed = await runtime.stopSession(binding);
  assert.equal(closed.phase, 'closed'); assert.equal(closed.custody, 'released');
  assert.deepEqual(records, []);
});

test('factory selection rethrows the exact original exception without attempting later ports', async t => {
  const records = capture(t), original = new RuntimeOwnerError('forbidden');
  const unexpected = (): never => assert.fail('no factory port after the selection refusal');
  const entry: MemberEntry = {
    config, binding,
    get profile() { return unexpected(); },
    get baseProfile() { return unexpected(); },
    get team() { return unexpected(); },
    get delivery() { return unexpected(); },
  };
  const options: Parameters<typeof createRuntimeMemberProviderFactory>[0] = {
    entries: new Map([['TEST-entry', entry]]), profileId: 'TEST-private-profile',
    storageRoot: '/TEST/no-native-execution', principalId: 'TEST-principal', hostIncarnation: 'TEST-host',
    get windows() { return unexpected(); },
    settleDeliveries: unexpected,
    isSealed: () => { throw original; },
    assertWriter: unexpected, assertCurrent: unexpected, captureInteractions: unexpected,
    readRuntime: unexpected, readCheckpoint: unexpected, observe: unexpected, onProgress: unexpected,
  };
  const factory = createRuntimeMemberProviderFactory(options);
  await assert.rejects(factory.open(config, () => {}), error => error === original);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.source, 'factory');
  assert.equal(records[0]!.phase, 'selection'); assert.equal(records[0]!.category, 'forbidden');
});

function profile(root: string): TeamHostProfile {
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-runtime-host' };
  return {
    schemaVersion: 1,
    owner: {
      ownerId: binding.backendId,
      revision: 'revision-1',
      storageRoot: root,
      profileId: 'TEST-profile',
      protocolVersion: 1,
      buildId: 'TEST-runtime-team-host',
      nodeSha256: 'a'.repeat(64),
      hostEntrySha256: 'b'.repeat(64),
    },
    principalId: 'human',
    teams: [
      {
        binding,
        scope: {
          projectId: 'TEST-project',
          workspaceId: 'TEST-workspace',
          teamId: binding.teamId,
          runId: 'TEST-run',
          memberId: 'human',
          generation: '1',
        },
        members: [
          {
            memberId: 'alice-id',
            name: 'alice',
            role: 'member',
            delivery: { ...binding, runId: 'TEST-run', memberId: 'alice-id', generation: '1' },
          },
          { memberId: 'bob-id', name: 'bob', role: 'member' },
        ],
        grants: [
          {
            principalId: 'human',
            memberName: 'user',
            permissions: ['read', 'task.write', 'message.write', 'admin'],
          },
          {
            principalId: 'alice-session',
            memberName: 'alice',
            permissions: ['read', 'task.write', 'message.write'],
          },
        ],
      },
    ],
    runtime: {
      members: [
        {
          teamId: binding.teamId,
          memberId: 'alice-id',
          principalId: 'alice-session',
          provider: 'claude',
          sessionId: 'PRIVATE-config-session',
          generation: 1,
          configRevision: 'PRIVATE-config-revision',
          cwd: root,
          model: 'PRIVATE-model',
          accountBinding: 'PRIVATE-account',
          environment: { HOME: root, PATH: '/TEST/no-native-execution', CLAUDE_CONFIG_DIR: root, TEST_TOKEN: 'PRIVATE-environment-token' },
          executable: { path: '/TEST/nonexistent-no-execution', sha256: 'c'.repeat(64) },
          nativeTools: [],
          autoAllowedTools: [],
          limits: {
            queuedInputs: 8,
            inputBytes: 65536,
            outputBytes: 65536,
            outputEvents: 256,
            pendingInteractions: 8,
            timeoutMs: 1000,
          },
        },
      ],
    },
  };
}


async function composedHost(t: TestContext, action: (context: MemberProviderContext) => Promise<Awaited<ReturnType<DriverFactory['open']>>>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-factory-open-diagnostic-')));
  const selected = profile(root), input = new PassThrough(), output = new PassThrough();
  const replies = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  let pending = '', sequence = 0, providerCalls = 0;
  output.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const frame = JSON.parse(pending.slice(0, newline)) as {
        id?: number; result?: unknown; error?: unknown;
      };
      pending = pending.slice(newline + 1);
      if (frame.id === undefined) continue;
      const reply = replies.get(frame.id);
      if (!reply) continue;
      replies.delete(frame.id);
      if (frame.error !== undefined) reply.reject(frame.error);
      else reply.resolve(frame.result);
    }
  });
  const host = createTeamHost(selected, { input, output }, {
    createProvider(context): MemberProvider {
      providerCalls++;
      const provider: MemberProvider = {
        factory: { open: async function (request) {
          assert.equal(this, provider.factory); assert.equal(request, context.request);
          return action(context);
        } },
        isReady: () => false, seal: () => {}, cleanup: async () => true,
      };
      return provider;
    },
  });
  t.after(async () => {
    try { await host.dispose(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  function rpc(method: string, params: unknown): Promise<unknown> {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      replies.set(id, { resolve, reject });
      input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  await rpc('host.handshake', { protocolVersion: 1 });
  const open = () => rpc('runtime.open', {
    commandId: 'TEST-original-open',
    binding: { schemaVersion: 1, handleId: 'TEST-handle',
      owner: selected.owner, scope: selected.teams[0]!.scope },
    payload: { memberId: 'alice-id' },
  });
  return { open, providerCalls: () => providerCalls, root };
}

for (const cleanupFailure of [false, true]) {
  test('real composition keeps the first factory refusal before endpoint close; cleanup failure=' + cleanupFailure,
    { timeout: 30_000 }, async t => {
      const order: string[] = [];
      const records = capture(t, record => { order.push(String(record.source) + ':' + String(record.phase)); });
      const cleanupError = new RuntimeOwnerError('busy');
      const originalClose = Server.prototype.close;
      t.mock.method(Server.prototype, 'close', function (
        this: Server, callback?: (error?: Error) => void
      ) {
        order.push('endpoint-close');
        return originalClose.call(this, (error?: Error) => {
          callback?.(error ?? (cleanupFailure ? cleanupError : undefined));
        });
      });
      const original = new RuntimeOwnerError('forbidden');
      const f = await composedHost(t, async () => { order.push('native-open'); throw original; });
      await f.open();
      assert.equal(f.providerCalls(), 1);
      const factory = records.filter(row => row.source === 'factory');
      const runtime = records.filter(row => row.source === 'runtime');
      assert.equal(factory.length, 1, 'cleanup cannot replace or repeat the first factory refusal');
      assert.equal(factory[0]!.phase, 'driver-open'); assert.equal(factory[0]!.category, 'forbidden');
      assert.equal(runtime.length, 1); assert.equal(runtime[0]!.phase, 'driver-open');
      assert.equal(runtime[0]!.category, cleanupFailure ? 'busy' : 'forbidden',
        'the original endpoint-close failure still takes precedence in the outer Runtime catch');
      assert.equal(factory[0]!.configurationHash, runtime[0]!.configurationHash);
      assert.ok(order.indexOf('native-open') < order.indexOf('factory:driver-open'));
      assert.ok(order.indexOf('factory:driver-open') < order.indexOf('endpoint-close'));
      assert.ok(order.indexOf('endpoint-close') < order.indexOf('runtime:driver-open'));
      const state = new FileRuntimeStore(f.root).fenced(binding, tx => tx.get());
      assert.equal(state?.phase, 'held'); assert.equal(state?.custody, 'unknown');
      assert.equal(state?.diagnostic, 'open-unknown');
      assert.equal(JSON.stringify(records).includes('PRIVATE-'), false);
    });
}

test('real composition with a finite successful driver does not manufacture a refusal',
  { timeout: 30_000 }, async t => {
    const records = capture(t), driver = session();
    const f = await composedHost(t, async context => ({
      driver, capabilities: [...context.request.requiredCapabilities],
    }));
    const result = await f.open() as { ok: boolean };
    assert.equal(result.ok, true); assert.equal(f.providerCalls(), 1);
    const state = new FileRuntimeStore(f.root).fenced(binding, tx => tx.get());
    assert.equal(state?.phase, 'allocated'); assert.equal(state?.nativeReady, true);
    assert.deepEqual(records, []);
  });
