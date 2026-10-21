import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexToolReceipt, flattenTools } from './model.ts';

test('pinned Codex MCP output timing header and Responses content items preserve authoritative receipt', () => {
  const receipt = { phase: 'completed', principalId: 'bob-session', effects: { taskId: 'real-task-id' } };
  const json = JSON.stringify({ result: receipt });
  assert.deepEqual(codexToolReceipt(`Wall time: 0.0123 seconds\nOutput:\n${json}`), receipt);
  assert.deepEqual(codexToolReceipt([{ type: 'input_text', text: 'Wall time: 0.0123 seconds\nOutput:' },
    { type: 'input_text', text: json }]), receipt);
  assert.deepEqual(flattenTools([{ type: 'namespace', name: 'mcp__team', tools: [{ name: 'task_create' }] },
    { type: 'function', name: 'exec_command' }]), [{ name: 'task_create', namespace: 'mcp__team' }, { name: 'exec_command' }]);
});
