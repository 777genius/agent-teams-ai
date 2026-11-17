import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePromptSuggestionProviders } from '../dist/composition/createCapturedPromptSuggestionBinding.js';

test('the Main startup preference is a strict subset of the known providers', () => {
  assert.deepEqual(parsePromptSuggestionProviders(''), []);
  assert.deepEqual(parsePromptSuggestionProviders('claude'), ['claude']);
  assert.deepEqual(parsePromptSuggestionProviders('claude,codex'), ['claude', 'codex']);
  // A typo, a duplicate or an unknown provider must fail closed instead of silently enabling extra inference.
  for (const invalid of [
    'Claude',
    'claude,',
    ',claude',
    'claude,claude',
    'opencode',
    'claude, codex',
    '1',
    'all',
  ])
    assert.throws(
      () => parsePromptSuggestionProviders(invalid),
      /Invalid native suggestion providers/u,
      invalid
    );
});
