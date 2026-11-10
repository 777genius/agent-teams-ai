import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mixedSemanticText } from './fixtures/native-mixed-task-notifications.ts';

test('reminder-only native envelopes never count as user input', () => {
  const reminder = '<system-reminder>native reminder</system-reminder>';
  assert.equal(mixedSemanticText(reminder), false);
  assert.equal(mixedSemanticText('   ' + reminder + '   '), false);
  assert.equal(mixedSemanticText(reminder.repeat(4_000)), false);
  assert.equal(mixedSemanticText(reminder.repeat(4_000) + ' actual user message '), true);
  assert.equal(mixedSemanticText(' before ' + reminder + ' after '), true);
  assert.equal(mixedSemanticText('<system-reminder>unterminated'), true);
  assert.equal(mixedSemanticText([{ type: 'text', text: reminder }]), false);
  assert.equal(mixedSemanticText([{ type: 'input_text', text: 'real input' }]), true);
});
