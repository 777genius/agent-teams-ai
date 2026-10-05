import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { macSerializedFunction } from './mac-serialization.mts';

// A named nested callback gets the same real esbuild transformation as the
// transport hook. Evaluate it in a foreign realm with no compiler globals.
function callback(value: number) {
  const increment = (input: number) => input + 1;
  return increment(value);
}
void test('compiled callback executes in an isolated signed-app-style lexical realm', () => {
  const originalName = () => {
    throw new Error('Foreign app helper must never be invoked');
  };
  const realm = { __name: originalName };
  // Only this module's fixed callback executes, in a bounded isolated realm.
  // eslint-disable-next-line sonarjs/code-eval
  const result: unknown = runInNewContext(`(${macSerializedFunction(callback)})(41)`, realm, {
    timeout: 500,
  });
  assert.equal(result, 42);
  assert.equal(realm.__name, originalName);
});
