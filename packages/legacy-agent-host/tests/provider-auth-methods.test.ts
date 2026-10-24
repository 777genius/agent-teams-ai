import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readProviderAuthMethods } from '../dist/adapters/providers/readProviderAuthMethods.js';

test('native auth method indices stay original while public form metadata omits unknown extensions', () => {
  const result = readProviderAuthMethods([{ type: 'future-type', secretExtension: 'TEST-secret' }, {
    type: 'oauth', label: 'TEST browser', secretExtension: 'TEST-secret', prompts: [{
      type: 'select', key: 'plan', message: 'TEST plan', options: [{ label: 'TEST work', value: 'work', secretExtension: 'TEST-secret' }],
      when: { key: 'account', op: 'eq', value: 'TEST-team' }, secretExtension: 'TEST-secret',
    }],
  }]);
  assert.equal(result[0]?.methodIndex, 1);
  assert.equal(result[0]?.supported, true);
  assert.equal(result[0]?.prompts[0]?.when?.op, 'eq');
  assert.equal(JSON.stringify(result).includes('TEST-secret'), false);
});

test('unknown prompt or conditional semantics disable that auth method instead of omitting required fields', () => {
  const result = readProviderAuthMethods([
    { type: 'api', label: 'TEST supported' },
    { type: 'oauth', prompts: [{ type: 'future-widget', key: 'TEST-required' }] },
    { type: 'oauth', prompts: [{ type: 'text', key: 'TEST-field', when: { key: 'a', op: 'future-operator', value: 'b' } }] },
  ]);
  assert.deepEqual(result.map((method) => [method.methodIndex, method.supported]), [[0, true], [1, false], [2, false]]);
});

test('bounded native auth metadata refuses oversized arrays', () => {
  assert.throws(() => readProviderAuthMethods(Array(129).fill({ type: 'api' })));
});

test('empty optional placeholder and option hint are valid native form metadata', () => {
  const result = readProviderAuthMethods([{ type: 'api', prompts: [{ type: 'text', key: 'TEST-key', placeholder: '' },
    { type: 'select', key: 'TEST-plan', options: [{ label: 'TEST work', value: 'work', hint: '' }] }] }]);
  assert.equal(result[0]?.supported, true);
  assert.equal(result[0]?.prompts[0]?.placeholder, '');
  assert.equal(result[0]?.prompts[1]?.options[0]?.hint, '');
});
