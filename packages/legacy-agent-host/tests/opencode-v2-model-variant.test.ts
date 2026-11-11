import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesOpenCodeV2ModelVariant } from '../src/adapters/providers/OpenCodeV2ModelVariant.ts';

for (const [captured, observed] of [
  [undefined, 'default'], [undefined, null], ['default', 'default'], ['default', null],
  ['high', 'high'], ['low', 'low'],
] as const) {
  test(`V2 variant readback accepts ${String(captured)} / ${String(observed)}`, () => {
    assert.equal(matchesOpenCodeV2ModelVariant(captured, observed), true);
  });
}
for (const [captured, observed] of [
  [undefined, undefined], [undefined, 'high'], ['high', null], ['high', 'default'],
  ['high', 'low'], ['default', 'high'], ['high', 'HIGH'], [undefined, ''],
  [undefined, ' default'], [undefined, 0], [undefined, false], [undefined, {}],
  [undefined, []], [undefined, new String('default')], ['high', new String('high')],
  [undefined, 'a'.repeat(257)], ['bad\nvariant', 'bad\nvariant'],
] as const) {
  test(`V2 variant readback refuses ${String(captured)} / ${String(observed)}`, () => {
    assert.equal(matchesOpenCodeV2ModelVariant(captured, observed), false);
  });
}
test('V2 comparison neither coerces native values nor treats malformed capture as default', () => {
  let coerced = false;
  const observed = { toString() { coerced = true; return 'default'; } };
  assert.equal(matchesOpenCodeV2ModelVariant(undefined, observed), false);
  assert.equal(coerced, false);
  for (const captured of [null, '', false, 0, {}, new String('default')])
    assert.equal(matchesOpenCodeV2ModelVariant(captured as unknown as string, null), false);
});
