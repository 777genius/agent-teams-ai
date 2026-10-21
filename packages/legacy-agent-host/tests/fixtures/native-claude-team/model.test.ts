import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeToolReceipt } from './model.ts';

test('native structured MCP receipt survives appended SDK reminders and JSON punctuation in strings', () => {
  const receipt = {
    phase: 'completed',
    principalId: 'alice-session',
    effects: { taskId: 'native-created-id' },
    subject: 'A { brace } and \\"quoted\\" text',
  };
  const text =
    JSON.stringify({ result: receipt }) +
    '\n\n<system-reminder>Keep tool-call identity.</system-reminder>';
  assert.deepEqual(nativeToolReceipt([{ type: 'text', text }]), receipt);
  assert.deepEqual(nativeToolReceipt(text), receipt);
  assert.throws(() => nativeToolReceipt('{"result":'), /missing or incomplete/);
});
