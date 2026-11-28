import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OpenCodeV2RuntimeLock, OpenCodeV2Selection } from '../src/composition/openCodeV2StaticPreflight.ts';

const sourceMode = process.env.LEGACY_PROVIDER_SOURCE_TEST === '1';
const { preflightOpenCodeV2Selection, preflightOpenCodeV2CurrentProduct }: typeof import('../src/composition/openCodeV2StaticPreflight.ts') =
  await import(sourceMode
    ? '../src/composition/openCodeV2StaticPreflight.ts'
    : '../dist/composition/openCodeV2StaticPreflight.js');

// Explicit historical UNIT descriptor, not a current native/runtime certificate.
function fixture(): { selected: OpenCodeV2Selection; lock: OpenCodeV2RuntimeLock } {
  return {
    selected: {
      generation: 'v2', platform: 'darwin-arm64', version: '2.0.0',
      nativeReportedVersion: '2.0.0', executableSha256: 'a'.repeat(64),
      observedExecutableSha256: 'a'.repeat(64), endpoint: 'http://127.0.0.1:14321',
      directory: '/TEST-owned-workspace', nativeSessionId: 'ses_TESTowned',
      sessionBinding: 'TEST-session', accountBinding: 'TEST-account',
    },
    lock: {
      version: 'TEST-historical-release',
      opencodeV2: { qualified: { 'darwin-arm64': ['2.0.0'] } },
      opencodeV2Delivery: { 'darwin-arm64': {
        schemaVersion: 1, bridgeProtocol: 1, runtimeVersion: 'TEST-historical-release',
        platform: 'darwin', arch: 'arm64', engineVersions: ['2.0.0'],
        sourceCommit: 'b'.repeat(40), archive: { sha256: 'c'.repeat(64) },
      } },
    },
  };
}

for (const gate of ['selection', 'current-product'] as const) {
  const evaluate = (selected: OpenCodeV2Selection, lock: OpenCodeV2RuntimeLock) =>
    gate === 'selection'
      ? preflightOpenCodeV2Selection(selected, lock)
      : preflightOpenCodeV2CurrentProduct(selected, lock, structuredClone(lock));

  test(`${gate}: canonical JSON data remains a static candidate only`, () => {
    const { selected, lock } = fixture();
    const expected = { kind: 'candidate', platform: 'darwin-arm64', version: '2.0.0',
      sourceCommit: 'b'.repeat(40), archiveSha256: 'c'.repeat(64) };
    assert.deepEqual(evaluate(JSON.parse(JSON.stringify(selected)), lock), expected);
    assert.deepEqual(evaluate(Object.freeze(selected), lock), expected);
    assert.deepEqual(evaluate(Object.assign(Object.create(null), selected), lock), expected);
  });

  test(`${gate}: required fields reject accessors without invoking them`, () => {
    const fields = Object.keys(fixture().selected) as Array<keyof OpenCodeV2Selection>;
    for (const key of fields) {
      const { selected, lock } = fixture();
      const original = selected[key];
      let reads = 0;
      Object.defineProperty(selected, key, {
        enumerable: true, get() { return ++reads === 1 ? original : 'FOREIGN'; },
      });
      assert.deepEqual(evaluate(selected, lock), { kind: 'hold', reason: 'binding' }, key);
      assert.equal(reads, 0, `the ${key} getter must never execute`);
    }
  });

  test(`${gate}: inherited fields and hidden fields are not JSON captures`, () => {
    const { selected, lock } = fixture();
    let reads = 0;
    const inherited = { ...selected };
    Reflect.deleteProperty(inherited, 'platform');
    Object.setPrototypeOf(inherited, { get platform() { reads++; return selected.platform; } });
    assert.deepEqual(evaluate(inherited, lock), { kind: 'hold', reason: 'binding' });
    assert.equal(reads, 0);
    const hidden = { ...selected };
    Object.defineProperty(hidden, 'platform', { enumerable: false });
    assert.deepEqual(evaluate(hidden, lock), { kind: 'hold', reason: 'binding' });
  });

  test(`${gate}: Proxy capture cannot counterfeit own data descriptors`, () => {
    const { selected, lock } = fixture();
    let traps = 0;
    const proxy = new Proxy(selected, {
      get(target, key, receiver) { traps++; return Reflect.get(target, key, receiver); },
      getOwnPropertyDescriptor(target, key) {
        traps++; return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    assert.deepEqual(evaluate(proxy, lock), { kind: 'hold', reason: 'binding' });
    assert.equal(traps, 0);
    const revoked = Proxy.revocable(selected, {});
    revoked.revoke();
    assert.deepEqual(evaluate(revoked.proxy, lock), { kind: 'hold', reason: 'binding' });
  });
}

test('one captured selection survives source mutation during both manifest evaluations', () => {
  const { selected, lock } = fixture();
  const productLock = structuredClone(lock);
  const qualified = lock.opencodeV2;
  let reads = 0;
  Object.defineProperty(lock, 'opencodeV2', { get() {
    reads++;
    selected.platform = 'win32-x64';
    selected.version = '2.1.4';
    selected.accountBinding = '';
    return qualified;
  } });
  assert.deepEqual(preflightOpenCodeV2CurrentProduct(selected, lock, productLock), {
    kind: 'candidate', platform: 'darwin-arm64', version: '2.0.0',
    sourceCommit: 'b'.repeat(40), archiveSha256: 'c'.repeat(64),
  });
  assert.ok(reads > 0, 'the mutation really happened after the snapshot');
  assert.equal(selected.platform, 'win32-x64');
});

for (const gate of ['selection', 'current-product'] as const) {
  for (const witness of ['sourceCommit', 'archive', 'sha256'] as const) {
    test(`${gate}: validates and returns one captured ${witness} witness`, () => {
      const { selected, lock } = fixture();
      // Clone before installing the adversarial getter; cloning itself reads it.
      const productLock = structuredClone(lock);
      const delivery = lock.opencodeV2Delivery?.[selected.platform];
      assert.ok(delivery?.archive);
      const target = witness === 'sha256' ? delivery.archive : delivery;
      const original = witness === 'sha256' ? delivery.archive.sha256 : delivery[witness];
      let reads = 0;
      Object.defineProperty(target, witness, {
        enumerable: true,
        // Previously typeof + regex passed, then the third read escaped unchecked.
        get() { return ++reads <= 2 ? original : 'FOREIGN'; },
      });
      const result = gate === 'selection'
        ? preflightOpenCodeV2Selection(selected, lock)
        : preflightOpenCodeV2CurrentProduct(selected, lock, productLock);
      assert.deepEqual(result, {
        kind: 'candidate', platform: selected.platform, version: selected.version,
        sourceCommit: 'b'.repeat(40), archiveSha256: 'c'.repeat(64),
      });
      assert.equal(reads, 1, 'validate and return the same observed witness');
    });
  }

  test(`${gate}: an invalid first witness is not replaced by a later valid read`, () => {
    for (const witness of ['sourceCommit', 'sha256'] as const) {
      const { selected, lock } = fixture();
      const productLock = structuredClone(lock);
      const delivery = lock.opencodeV2Delivery?.[selected.platform];
      assert.ok(delivery?.archive);
      const target = witness === 'sha256' ? delivery.archive : delivery;
      const original = witness === 'sha256' ? delivery.archive.sha256 : delivery.sourceCommit;
      let reads = 0;
      Object.defineProperty(target, witness, {
        enumerable: true, get() { return ++reads === 1 ? 'FOREIGN' : original; },
      });
      const result = gate === 'selection'
        ? preflightOpenCodeV2Selection(selected, lock)
        : preflightOpenCodeV2CurrentProduct(selected, lock, productLock);
      assert.deepEqual(result, { kind: 'hold', reason: 'delivery' });
      assert.equal(reads, 1, 'do not replace an invalid capture with a second read');
    }
  });
}
