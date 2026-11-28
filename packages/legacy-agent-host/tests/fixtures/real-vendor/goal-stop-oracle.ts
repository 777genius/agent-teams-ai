import assert from 'node:assert/strict';

import { normalizeBinding, runtimeDigest } from '../../../dist/runtime/identity.js';
import type { RuntimeBinding, RuntimeInput, RuntimeSessionRecord } from '../../../dist/runtime/contracts.js';

const active = (phase: RuntimeInput['phase']) => phase === 'claimed' || phase === 'consumed';
const started = (phase: RuntimeInput['phase']) => active(phase) || phase === 'terminal';
const bindingKey = (binding: RuntimeBinding) => runtimeDigest(normalizeBinding(binding));

export interface GoalStopWitness {
  binding: RuntimeBinding;
  inputs: { inputId: string; operationRef: string; fingerprint: string;
    phase: RuntimeInput['phase']; terminal?: RuntimeInput['terminal'] }[];
}

/** Read-only TEST evidence. Never retain provider configuration or credentials. */
export function captureGoalStopWitness(records: readonly RuntimeSessionRecord[]): GoalStopWitness[] {
  assert.equal(new Set(records.map(record => bindingKey(record.binding))).size, records.length);
  assert.ok(records.some(record => record.inputs.some(input => active(input.phase))),
    'Goal Stop must observe an original active input');
  return records.map(record => ({ binding: normalizeBinding(record.binding),
    inputs: record.inputs.map(input => ({ inputId: input.intent.inputId, operationRef: input.operationRef,
      fingerprint: input.fingerprint, phase: input.phase, ...(input.terminal ? { terminal: input.terminal } : {}) })) }));
}

/** Qualification only: original native success and cleanup remain separate facts. */
export function goalStopInputsSettled(original: readonly GoalStopWitness[],
  records: readonly RuntimeSessionRecord[]): boolean {
  assert.equal(records.length, original.length, 'every original Stop binding remains available');
  assert.equal(new Set(records.map(record => bindingKey(record.binding))).size, records.length);
  let settled = true;
  for (const before of original) {
    const record = records.find(row => bindingKey(row.binding) === bindingKey(before.binding));
    assert.ok(record, 'Stop retains its original Runtime binding');
    for (const input of record.inputs) {
      assert.deepEqual(normalizeBinding(input.intent.binding), normalizeBinding(record.binding));
      assert.notEqual(input.phase, 'unknown', 'unknown native effects are not a successful Stop proof');
      assert.ok(before.inputs.some(row => row.inputId === input.intent.inputId && started(row.phase)) ||
        ['admitted', 'cancelled', 'rejected', 'not-sent'].includes(input.phase),
      'Stop cannot claim either a new input or an originally admitted but unclaimed input');
    }
    for (const previous of before.inputs.filter(input => started(input.phase))) {
      const input: RuntimeInput | undefined = record.inputs.find(row => row.intent.inputId === previous.inputId);
      assert.ok(input, 'an originally started Stop input cannot disappear');
      assert.equal(input.operationRef, previous.operationRef, 'the original Stop operation cannot change');
      assert.equal(input.fingerprint, previous.fingerprint, 'the original Stop fingerprint cannot change');
      if (active(previous.phase)) {
        if (active(input.phase)) settled = false;
        else assert.ok(input.phase === 'terminal' && input.terminal === 'succeeded',
          'an originally active Stop input must settle successfully');
      } else {
        assert.equal(input.phase, previous.phase, 'retained original settlement cannot change');
        assert.equal(input.terminal, previous.terminal, 'retained original outcome cannot change');
      }
    }
  }
  return settled;
}
