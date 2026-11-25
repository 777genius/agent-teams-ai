import assert from 'node:assert/strict';

type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
export const SCHEDULE_FINITE_PROMPT = 'TEST_SCHEDULE_DESKTOP_FINITE';
export const SCHEDULE_SMART_PROMPT = 'TEST_SCHEDULE_DESKTOP_SMART';
export const SCHEDULE_SMART_LABEL = 'TEST scheduled board task';
export interface NativeScheduleScenario {
  task(): { id: string; owner: string; status: string };
}

/** Only model responses are scripted; native Bash and Team MCP must perform every effect. */
export function nativeScheduleScript(options: NativeScheduleScenario, readReceipt: (value: unknown) => Row) {
  const requests: { mode: 'finite' | 'smart'; step: number; model: string; taskId?: string }[] = [];
  const counts = new Map<string, number>();
  let originalTaskId: string | undefined;
  return {
    requests,
    respond(body: Row, tools: string[]): Row | undefined {
      const messages = (Array.isArray(body.messages) ? body.messages : []).map(row);
      const serialized = JSON.stringify(messages);
      const finite = serialized.includes(SCHEDULE_FINITE_PROMPT), smart = serialized.includes(SCHEDULE_SMART_PROMPT);
      if (!finite && !smart) return undefined; // Existing model-probe handler owns unrelated readiness inputs.
      assert.notEqual(finite, smart, 'each native input belongs to one scheduled execution mode');
      const mode = finite ? 'finite' : 'smart', step = counts.get(mode) ?? 0;
      assert.ok(step < (finite ? 2 : 4), 'one bounded original native schedule, no replay');
      assert.equal(body.model, 'claude-sonnet-4-6');
      const task = smart ? options.task() : undefined;
      if (task) {
        originalTaskId ??= task.id;
        assert.equal(task.id, originalTaskId, 'all native tools belong to the original scheduled board task');
        assert.equal(task.owner, 'alice');
        assert.ok(serialized.includes(task.id), 'original task identity is present in the actual native input');
        assert.equal(task.status, step < 2 ? 'in_progress' : 'completed');
      }
      const blocks = messages.flatMap(message => Array.isArray(message.content) ? message.content.map(row) : []);
      if (step > 0) {
        const previous = blocks.find(block => block.type === 'tool_result' &&
          block.tool_use_id === `TEST-schedule-${mode}-${step - 1}`);
        assert.ok(previous, 'the exact original native tool result reached the next model request');
        assert.notEqual(previous.is_error, true);
        if (step === 1) assert.match(JSON.stringify(previous.content), /TEST_SCHEDULE_NATIVE_EFFECT/);
        else assert.equal(readReceipt(previous.content).phase, 'completed', 'native MCP command completed through Host');
      }
      requests.push({ mode, step, model: String(body.model), ...(task ? { taskId: task.id } : {}) });
      counts.set(mode, step + 1);
      if (step === 0) {
        assert.ok(tools.includes('Bash'));
        return { type: 'tool_use', id: `TEST-schedule-${mode}-${step}`, name: 'Bash', input: {
          command: `printf '%s\\n' 'TEST_SCHEDULE_NATIVE_EFFECT' > 'schedule-${mode}.txt'; cat 'schedule-${mode}.txt'`,
          description: 'Write the original private scheduled TEST effect',
        } };
      }
      if (smart && step < 3) {
        const name = step === 1 ? 'task_complete' : 'message_send';
        assert.ok(tools.includes(`mcp__team__${name}`));
        return { type: 'tool_use', id: `TEST-schedule-${mode}-${step}`, name: `mcp__team__${name}`,
          input: step === 1 ? { commandId: 'TEST-scheduled-complete', taskId: task!.id }
            : { commandId: 'TEST-scheduled-reply', to: 'user', text: 'TEST_SCHEDULE_SMART_DONE' } };
      }
      return { type: 'text', text: finite ? 'TEST_SCHEDULE_FINITE_DONE' : 'TEST_SCHEDULE_SMART_COMPLETE' };
    },
  };
}
