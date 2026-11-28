import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOpenCodeInputModalities } from '../dist/adapters/providers/readOpenCodeInputModalities.js';

test('native declaration preserves explicit none and refuses missing, malformed or conflicting media metadata', () => {
  for (const [raw, expected] of [
    [{ modalities: { input: ['text', 'image'] } }, ['image', 'text']],
    [{ capabilities: { input: ['video'] } }, ['video']],
    [{ capabilities: { input: { image: true, video: false, text: true } } }, ['image', 'text']],
    [{ capabilities: { input: { image: false, video: false } } }, []],
    [{ modalities: { input: [] } }, []],
    [{ capabilities: { input: [] } }, []],
    [{}, null],
    [{ capabilities: {} }, null],
    [{ capabilities: { input: ['image', 1] } }, null],
    [{ capabilities: { input: { image: 'true' } } }, null],
    [{ modalities: { input: { image: true } } }, null],
    [{ modalities: { input: ['image'] }, capabilities: { input: { image: false } } }, null],
    [{ modalities: { input: ['image'] }, capabilities: { input: ['image', 'text'] } }, ['image']],
  ] as const)
    assert.deepEqual(readOpenCodeInputModalities(raw), expected);
});
