import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { createOpenCodeLocalModelReadiness } from '../dist/adapters/providers/OpenCodeLocalModelReadiness.js';
import { captureOpenCodeProbeAccount } from '../dist/composition/openCodeProbeAccount.js';
import { ManagementCommandError } from '../dist/management/commandRecords.js';
import { managementDigest } from '../dist/management/identity.js';
import { openCodeManagementProfileSchema } from '../dist/management/profile.js';

const providerId = 'TEST-provider', modelId = 'TEST-model';
const maximum = 256 * 1024;
const consumers = ['readiness', 'account'] as const;
type Consumer = (typeof consumers)[number];
const refusal = (consumer: Consumer) => (error: unknown) =>
  error instanceof ManagementCommandError && error.code === (consumer === 'readiness' ? 'invalid' : 'held');

function fixture(t: TestContext, apiKey: unknown, environment: Record<string, string> = {},
  baseURL = 'https://example.test/v1') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-opencode-bounded-environment-')));
  const probes: ReturnType<typeof createOpenCodeLocalModelReadiness>[] = [];
  t.after(async () => {
    try { for (const probe of probes) await probe.close(Date.now() + 5000); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  const home = join(root, 'home'), cwd = join(root, 'workspace');
  const config = join(root, 'config'), data = join(root, 'data'), cache = join(root, 'cache');
  for (const path of [home, cwd, config, data, cache]) mkdirSync(path, { mode: 0o700 });
  const profile = openCodeManagementProfileSchema.parse({
    provider: 'opencode', profileId: 'TEST-environment-profile', configRevision: 'TEST-environment-revision',
    accountBinding: 'TEST-account', cwd, executable: { path: process.execPath, sha256: 'a'.repeat(64) },
    environment: { HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_CACHE_HOME: cache, ...environment },
    endpoint: 'http://127.0.0.1:12345', timeoutMs: 5000, modelProbeTimeoutMs: 5000,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(profile)) <= 256 * 1024);
  const path = join(cwd, 'opencode.json');
  const write = (key: unknown) => {
    const bytes = JSON.stringify({ provider: { [providerId]: {
      npm: '@ai-sdk/openai-compatible', options: { baseURL, apiKey: key },
      models: { [modelId]: { name: modelId } },
    } } });
    assert.ok(Buffer.byteLength(bytes) <= 1024 * 1024);
    writeFileSync(path, bytes, { mode: 0o600 });
  };
  write(apiKey);
  let factories = 0, runs = 0, closes = 0;
  const account = () => captureOpenCodeProbeAccount(profile, { providerId, modelId }, () => true);
  const readiness = () => {
    const probe = createOpenCodeLocalModelReadiness(profile, {
      commandId: 'TEST-environment-probe', profileId: profile.profileId,
      configRevision: profile.configRevision, providerId, modelId,
    }, () => true, {
      ordinary() {
        factories++;
        return { timeoutMs: 5000, run: async () => { runs++; return false; },
          close: async () => { closes++; return true; } };
      },
      coordination: () => assert.fail('TEST bounded resolution cannot start native coordination'),
      fetchImpl: async () => assert.fail('TEST bounded resolution cannot perform a network request'),
    });
    probes.push(probe);
    return probe;
  };
  return { profile, path, write, account, readiness, counts: () => ({ factories, runs, closes }) };
}

async function assertAccountValue(f: ReturnType<typeof fixture>, consumer: Consumer, value: unknown) {
  const expected = managementDigest({ binding: f.profile.accountBinding, key: null,
    configuredKey: typeof value === 'string' ? value : null });
  if (consumer === 'account') {
    const account = f.account();
    assert.ok(account);
    assert.equal(account.digest, expected);
    assert.equal(account.isCurrent(), true);
  } else {
    const probe = f.readiness();
    assert.equal(await probe.run(new AbortController().signal, Date.now() + 5000), false);
    const evidence = probe.readiness();
    assert.ok(evidence);
    assert.equal(evidence.accountDigest, expected);
  }
}

for (const consumer of consumers) {
  test(consumer + ' refuses amplified environment input before native construction or account publication', (t) => {
    // Five legal 64 KiB values exceed the new bound without allocating an unbounded test string.
    const f = fixture(t, '{env:TEST_KEY}'.repeat(5), { TEST_KEY: 'x'.repeat(64 * 1024) });
    const before = readFileSync(f.path, 'utf8');
    assert.throws(() => f[consumer](), refusal(consumer));
    assert.deepEqual(f.counts(), { factories: 0, runs: 0, closes: 0 });
    assert.equal(readFileSync(f.path, 'utf8'), before);
  });

  test(consumer + ' preserves the exact UTF8 limit and refuses one extra byte', async (t) => {
    const key = 'é'.repeat(64 * 1024);
    const f = fixture(t, '{env:TEST_KEY}' + '$' + '{TEST_KEY}', { TEST_KEY: key });
    const expected = key + key;
    assert.equal(Buffer.byteLength(expected), maximum);
    await assertAccountValue(f, consumer, expected);
    f.write('{env:TEST_KEY}' + '$' + '{TEST_KEY}x');
    const before = readFileSync(f.path, 'utf8'), counts = f.counts();
    assert.throws(() => f[consumer](), refusal(consumer));
    assert.deepEqual(f.counts(), counts);
    assert.equal(readFileSync(f.path, 'utf8'), before);
  });
}

test('both V1 consumers preserve a legal 64 Ki UTF16 Unicode credential exactly', async (t) => {
  const expected = '漢'.repeat(64 * 1024);
  assert.equal(expected.length, 64 * 1024);
  assert.ok(Buffer.byteLength(expected) > 64 * 1024);
  const f = fixture(t, '{env:TEST_KEY}', { TEST_KEY: expected });
  for (const consumer of consumers) await assertAccountValue(f, consumer, expected);
});

test('surrogates spanning literal and replacement boundaries use the joined UTF8 size', async (t) => {
  const prefix = 'x'.repeat(maximum - 4);
  const f = fixture(t, prefix + '\ud83d{env:LOW}', { LOW: '\ude00' });
  const expected = prefix + '😀';
  assert.equal(Buffer.byteLength(expected), maximum);
  for (const consumer of consumers) await assertAccountValue(f, consumer, expected);
  f.write(prefix + '{env:HIGH}{env:LOW}');
  f.profile.environment.HIGH = '\ud83d';
  for (const consumer of consumers) await assertAccountValue(f, consumer, expected);
});

test('environment substitutions retain one-pass semantics and do not reinterpret inserted tokens', async (t) => {
  const expected = '$' + '{NOT_SELECTED}-{file:TEST-not-a-file-read}';
  const f = fixture(t, '{env:TEST_KEY}', { TEST_KEY: expected });
  for (const consumer of consumers) await assertAccountValue(f, consumer, expected);
});

for (const [name, value, environment] of [
  ['missing variable', '{env:MISSING}', {}],
  ['NUL environment value', '{env:TEST_KEY}', { TEST_KEY: 'TEST\0key' }],
  ['original file token', '{file:TEST-never-read}', {}],
] as const) {
  test('both V1 consumers preserve the original ' + name + ' refusal', (t) => {
    const f = fixture(t, value, environment);
    const before = readFileSync(f.path, 'utf8');
    for (const consumer of consumers) assert.throws(() => f[consumer](), refusal(consumer));
    assert.deepEqual(f.counts(), { factories: 0, runs: 0, closes: 0 });
    assert.equal(readFileSync(f.path, 'utf8'), before);
  });
}

test('a valid Unicode URL keeps the existing UTF16 URL policy', async (t) => {
  const url = 'https://example.test/' + '漢'.repeat(1000);
  assert.ok(url.length < 2048);
  assert.ok(Buffer.byteLength(url) > 2048);
  const f = fixture(t, 'TEST-key', { TEST_URL: url }, '{env:TEST_URL}');
  await assertAccountValue(f, 'account', 'TEST-key');
  const probe = f.readiness();
  assert.equal(await probe.run(new AbortController().signal, Date.now() + 5000), false);
  assert.equal(probe.readiness()?.routeDigest, managementDigest({
    providerId, modelId, baseUrl: new URL(url).toString(), effort: null, limits: null,
  }));
});

test('non-string configured values preserve the existing absent-key identity', async (t) => {
  for (const value of [undefined, null, 7, false]) {
    const f = fixture(t, value);
    for (const consumer of consumers) await assertAccountValue(f, consumer, null);
  }
});
