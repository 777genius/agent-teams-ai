// Responses SSE shapes are reused from the archived actual Codex 0.162 proof.
// This fixture scripts only inference; native app-server executes all tools.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { nativeToolReceipt } from '../native-claude-team/model.ts';
export type RecordValue = Record<string, unknown>;
export const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as RecordValue : {};
export const CONTEXT_MARKER = 'TEST_CODEX_CAPTURED_MEMBER_CONTEXT_V1';
export const REQUIRED_TOOLS = ['task_create', 'task_set_owner', 'task_start', 'task_add_comment', 'task_complete', 'message_send'];
interface Tool { name: string; namespace?: string }
/** Codex's pinned McpToolOutput adds this native timing header before MCP data. */
export function codexToolReceipt(output: unknown): RecordValue {
  if (typeof output === 'string')
    return nativeToolReceipt(output.replace(/^Wall time: [0-9.]+ seconds\nOutput:\n?/, ''));
  const content = (Array.isArray(output) ? output : []).map(record)
    .filter(block => block.type === 'input_text' || block.type === 'text')
    .map(block => ({ type: 'text', text: block.text }));
  return nativeToolReceipt(content);
}
export function flattenTools(value: unknown): Tool[] {
  return (Array.isArray(value) ? value : []).flatMap(raw => {
    const tool = record(raw);
    if (tool.type === 'namespace' && Array.isArray(tool.tools))
      return tool.tools.map(child => ({ name: String(record(child).name), namespace: String(tool.name) }));
    return [{ name: String(tool.name) }];
  });
}
export async function startCodexModel() {
  const observations: { turn: string; step: number; contextEffective: boolean; priorTurn: boolean; tools: Tool[] }[] = [];
  const failures: string[] = [];
  const counts = new Map<string, number>();
  let taskId: string | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(failures.length, 0, 'oracle seals after its first protocol failure');
      assert.equal(request.method, 'POST'); assert.match(request.url ?? '', /\/v1\/responses$/);
      assert.ok(observations.length < 16);
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const raw of request) {
        const chunk = Buffer.from(raw as Uint8Array); bytes += chunk.length;
        assert.ok(bytes < 2_000_000); chunks.push(chunk);
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      const input = (Array.isArray(body.input) ? body.input : []).map(record);
      let turn = '';
      for (const message of input.toReversed()) {
        if (message.role !== 'user') continue;
        const match = /CODEX_TEAM_(ONE|TWO)/.exec(JSON.stringify(message.content));
        if (match) { turn = match[0]; break; }
      }
      assert.ok(turn, 'actual native request retains deliberate TEST input');
      const step = counts.get(turn) ?? 0;
      const contextEffective = JSON.stringify([body.instructions,
        input.filter(item => item.role === 'developer' || item.role === 'system')]).includes(CONTEXT_MARKER);
      assert.ok(contextEffective, 'actual native request contains fixed role/team/workspace instructions');
      const tools = flattenTools(body.tools);
      if (turn === 'CODEX_TEAM_ONE' && step === 1) {
        const result = input.filter(item => item.type === 'function_call_output').at(-1);
        const receipt = codexToolReceipt(result?.output);
        assert.equal(receipt.phase, 'completed'); assert.equal(receipt.principalId, 'bob-session');
        taskId = String(record(receipt.effects).taskId); assert.ok(taskId && taskId !== 'undefined');
      }
      observations.push({ turn, step, contextEffective,
        priorTurn: JSON.stringify(input).includes('CODEX_TEAM_ONE'), tools });
      const one = [
        { name: 'task_create', input: { commandId: 'codex-task-create', subject: 'Native Codex TEST task' } },
        { name: 'task_set_owner', input: { commandId: 'codex-task-assign', taskId, owner: 'bob' } },
        { name: 'task_start', input: { commandId: 'codex-task-start', taskId } },
        { name: 'exec_command', input: { cmd: "printf 'ONE\\n' >> native-effect.txt; exit 7", yield_time_ms: 1000, max_output_tokens: 500 } },
        { name: 'task_add_comment', input: { commandId: 'codex-task-comment', taskId, text: 'Codex native command wrote TEST bytes and exited seven.' } },
        { name: 'task_complete', input: { commandId: 'codex-task-complete', taskId } },
        { name: 'message_send', input: { commandId: 'codex-reply-one', to: 'user', text: 'REPLY_CODEX_ONE' } },
      ];
      const two = [
        { name: 'exec_command', input: { cmd: "printf 'TWO\\n' >> native-effect.txt", yield_time_ms: 1000, max_output_tokens: 500 } },
        { name: 'message_send', input: { commandId: 'codex-reply-two', to: 'user', text: 'REPLY_CODEX_TWO' } },
      ];
      const action = (turn === 'CODEX_TEAM_ONE' ? one : two)[step];
      let output: RecordValue;
      if (action) {
        const chosen = tools.find(tool => action.name === 'exec_command' ? tool.name === action.name
          : (tool.name === action.name && tool.namespace?.includes('team')) || tool.name.endsWith(`__${action.name}`));
        assert.ok(chosen, `actual Codex tool catalog contains ${action.name}`);
        output = { type: 'function_call', call_id: `native_${turn}_${step}`, name: chosen.name,
          ...(chosen.namespace ? { namespace: chosen.namespace } : {}), arguments: JSON.stringify(action.input) };
      } else output = { type: 'message', role: 'assistant', id: `TEST-final-${turn}`,
        content: [{ type: 'output_text', text: `DONE_${turn}` }] };
      counts.set(turn, step + 1);
      const id = `TEST-codex-response-${observations.length}`;
      const events = [{ type: 'response.created', response: { id } },
        { type: 'response.output_item.done', item: output },
        { type: 'response.completed', response: { id, usage: { input_tokens: 10,
          input_tokens_details: null, output_tokens: 10, output_tokens_details: null, total_tokens: 20 } } }];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    })().catch(error => {
      failures.push(error instanceof Error ? error.message : 'fixture-failed');
      if (!response.headersSent) response.writeHead(400);
      response.end('TEST Responses fixture rejected request');
    });
  });
  server.requestTimeout = 15_000;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, observations, failures,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
