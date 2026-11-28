import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as selection from '../dist/composition/openCodeSelectedProviderConfiguration.js';

const providerId = 'TEST-provider', modelId = 'TEST-model';
const limit = 256 * 1024;
const invalid = { reason: 'configuration-invalid' };
const chunk = 'x'.repeat(64 * 1024);
const excessive = '{env:TEST_BIG}'.repeat(17);
const environment = { TEST_BIG: chunk };
const withProto = (value: unknown, rest: Record<string, unknown> = {}) =>
  Object.fromEntries([['__proto__', value], ...Object.entries(rest)]);
const choose = (model: unknown, env: Readonly<Record<string, string>> = {}) =>
  selection.selectOpenCodeV2ProviderConfiguration(
    { provider: { [providerId]: { models: { [modelId]: model } } } },
    { providerId, modelId }, env
  ).configuration;
const expected = (model: unknown) => ({ models: { [modelId]: model } });

test('retained expansion refuses before reading later model values', () => {
  let selectedReads = 0, laterReads = 0;
  const env = {
    get TEST_BIG() { selectedReads++; return chunk; },
    get TEST_LATER() { laterReads++; return 'TEST later value'; },
  };
  const model = { name: excessive, headers: { 'x-test-later': '{env:TEST_LATER}' } };
  const before = JSON.stringify(model);
  assert.throws(() => choose(model, env), invalid);
  assert.equal(selectedReads, 9, 'the ninth 64 KiB replacement exceeds the derived 512 KiB bound');
  assert.equal(laterReads, 0);
  assert.equal(JSON.stringify(model), before);
});

test('legacy modalities can still replace oversized capability values without importing them', () => {
  for (const axis of ['input', 'output'] as const) {
    const capabilities = { tools: true, input: ['text'], output: ['text'], [axis]: [excessive] };
    const model = { capabilities, modalities: { [axis]: ['text'] } };
    const before = JSON.stringify(model);
    assert.deepEqual(choose(model, environment), expected({
      capabilities: { tools: true, input: ['text'], output: ['text'] },
    }));
    assert.equal(JSON.stringify(model), before);
  }
  assert.deepEqual(choose({
    capabilities: { tools: true, input: { obsolete: excessive }, output: ['text'] },
    modalities: { input: ['text'] },
  }, environment), expected({ capabilities: { tools: true, input: ['text'], output: ['text'] } }));
});

test('an unoverridden capability axis is still retained and bounded', () => {
  const model = {
    capabilities: { tools: true, input: ['text'], output: [excessive] },
    modalities: { input: ['text'] },
  };
  assert.throws(() => choose(model, environment), invalid);
});

test('record and nested JSON omissions preserve all remaining selected values', () => {
  const model = {
    headers: withProto({ discarded: excessive }, { 'x-test-header': 'TEST header' }),
    body: withProto(excessive, {
      nested: [withProto(excessive, { keep: 'TEST nested body' })],
    }),
    settings: withProto(excessive, {
      compaction: { type: 'summary' },
      encoding: 'gzip',
      custom: [withProto(excessive, { keep: 'TEST nested settings' })],
    }),
  };
  const before = JSON.stringify(model);
  assert.deepEqual(choose(model, environment), expected({
    headers: { 'x-test-header': 'TEST header' },
    body: { nested: [{ keep: 'TEST nested body' }] },
    settings: {
      compaction: { type: 'summary' },
      encoding: 'gzip',
      custom: [{ keep: 'TEST nested settings' }],
    },
  }));
  assert.equal(JSON.stringify(model), before);
});

test('discarded values still validate original file tokens, missing variables and replacement NUL', () => {
  for (const value of ['{file:TEST-never-read}', '{env:MISSING}', '{env:TEST_NUL}']) {
    const env = { TEST_NUL: 'TEST\0value' };
    for (const model of [
      { capabilities: { tools: true, input: [value], output: ['text'] }, modalities: { input: ['text'] } },
      { headers: withProto(value) },
      { body: { nested: [withProto({ value })] } },
      { settings: withProto(value) },
      { variants: { high: { custom: withProto(value) } } },
    ]) {
      const before = JSON.stringify(model);
      assert.throws(() => choose(model, env), invalid);
      assert.equal(JSON.stringify(model), before);
    }
  }
});

test('raw literal NUL and inserted tokens keep their existing one-pass meanings', () => {
  const inserted = 'TEST-{file:still-literal}-{env:NOT_CONSULTED}';
  const model = {
    name: '{env:TEST_INSERTED}',
    body: { literal: 'TEST\0literal' },
    settings: withProto('TEST\0discarded', { kept: 'TEST\0settings' }),
    capabilities: { tools: true, input: ['{env:TEST_INSERTED}'], output: ['text'] },
    modalities: { input: ['text'] },
  };
  assert.deepEqual(choose(model, { TEST_INSERTED: inserted }), expected({
    name: inserted,
    body: { literal: 'TEST\0literal' },
    settings: { kept: 'TEST\0settings' },
    capabilities: { tools: true, input: ['text'], output: ['text'] },
  }));
});

test('strict object keys named __proto__ remain errors instead of becoming omitted JSON', () => {
  for (const model of [
    withProto('TEST unknown field', { name: 'TEST model' }),
    { capabilities: withProto('TEST unknown field', { tools: true, input: ['text'], output: ['text'] }) },
    { compatibility: withProto('TEST unknown field', { reasoningField: 'reasoning' }) },
    { settings: { compaction: withProto('TEST unknown field', { type: 'summary' }) } },
    { modalities: withProto('TEST unknown field', { input: ['text'] }) },
    { variants: [withProto('TEST unknown field', { id: 'high' })] },
    { cost: withProto('TEST unknown field', { input: 1, output: 1 }) },
    { capabilities: {
      tools: true, input: ['text'], output: ['text'],
      reasoning: withProto('TEST unknown field', { supported: false }),
    } },
  ]) assert.throws(() => choose(model), invalid);
});

test('a legacy variant named __proto__ remains a real variant with settings semantics', () => {
  const variants = Object.fromEntries([
    ['__proto__', withProto(excessive, {
      encoding: 'gzip',
      custom: withProto(excessive, { keep: 'TEST variant setting' }),
    })],
  ]);
  const model = { variants }, before = JSON.stringify(model);
  assert.deepEqual(choose(model, environment), expected({
    variants: [{ id: '__proto__', settings: { encoding: 'gzip', custom: { keep: 'TEST variant setting' } } }],
  }));
  assert.equal(JSON.stringify(model), before);
  assert.throws(() => choose({ variants: { high: { disabled: false } } }), invalid);
});

test('array variants use their own overlays and retain strict variant validation', () => {
  const model = { variants: [{
    id: 'high',
    settings: withProto(excessive, { custom: withProto(excessive, { keep: 'TEST setting' }) }),
    headers: withProto(excessive, { 'x-test': 'TEST header' }),
    body: withProto(excessive, { nested: [withProto(excessive, { keep: 'TEST body' })] }),
  }] };
  assert.deepEqual(choose(model, environment), expected({ variants: [{
    id: 'high',
    settings: { custom: { keep: 'TEST setting' } },
    headers: { 'x-test': 'TEST header' },
    body: { nested: [{ keep: 'TEST body' }] },
  }] }));
  assert.throws(() => choose({ variants: [{ id: 'high', unsupported: true }] }), invalid);
});

test('both checked package aliases fit the derived budget at the actual final JSON boundary', () => {
  for (const unit of ['x', '漢']) {
    const overhead = Buffer.byteLength(JSON.stringify(expected({ package: 'aisdk:' })));
    const length = limit - overhead;
    const width = Buffer.byteLength(unit);
    const raw = unit.repeat(Math.floor(length / width)) + 'x'.repeat(length % width);
    const model = { npm: raw, package: 'aisdk:' + raw };
    const before = JSON.stringify(model), actual = choose(model);
    assert.deepEqual(actual, expected({ package: 'aisdk:' + raw }));
    assert.equal(Buffer.byteLength(JSON.stringify(actual)), limit);
    assert.equal(JSON.stringify(model), before);
    assert.throws(() => choose({ npm: raw + 'x', package: 'aisdk:' + raw + 'x' }), invalid);
  }
  assert.deepEqual(choose({ id: 'TEST-upstream', modelID: 'TEST-upstream' }),
    expected({ modelID: 'TEST-upstream' }));
  assert.throws(() => choose({ id: 'TEST-original', modelID: 'TEST-other' }), invalid);
  assert.throws(() => choose({ npm: 'TEST-package', package: 'TEST-package' }), invalid);
});

test('selected model dictionary keys named __proto__ are not schema metadata', () => {
  const id = '__proto__';
  const models = Object.fromEntries([[id, { body: withProto(excessive, { keep: 'TEST original model' }) }]]);
  const actual = selection.selectOpenCodeV2ProviderConfiguration(
    { provider: { [providerId]: { models } } }, { providerId, modelId: id }, environment
  ).configuration;
  assert.deepEqual(actual, { models: Object.fromEntries([[id, { body: { keep: 'TEST original model' } }]]) });
});

test('the per-selection proof does not impose a new cumulative catalogue policy', () => {
  const url = 'https://example.test/' + '漢'.repeat(2000);
  assert.ok(url.length <= 2048);
  assert.ok(Buffer.byteLength(url) * 2049 > 8 * 1024 * 1024);
  const models = Object.fromEntries(Array.from({ length: 2048 }, (_, index) => [
    'TEST-model-' + index, { name: 'TEST model ' + index },
  ]));
  const config = { provider: { [providerId]: {
    npm: '@ai-sdk/openai-compatible',
    options: { baseURL: '{env:TEST_URL}' },
    models,
  } } };
  const before = JSON.stringify(config);
  const actual = selection.selectOpenCodeV2CatalogConfiguration(
    config, { providerId, modelId: 'TEST-model-0' }, { TEST_URL: url }
  ).configuration;
  assert.deepEqual(actual, {
    package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: url }, models,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(actual)) <= limit);
  assert.equal(JSON.stringify(config), before);
});
