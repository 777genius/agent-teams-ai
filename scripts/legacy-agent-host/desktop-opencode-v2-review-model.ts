import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { CONTEXT_MARKER } from '../../packages/legacy-agent-host/tests/fixtures/native-opencode-team/model.ts';
import { isOpenCodeModelProbe } from '../../packages/legacy-agent-host/tests/fixtures/native-opencode-team/model-probe.ts';
import { nativeToolReceipt, record } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
import type { ServerResponse } from 'node:http';

export const V2_REVIEW_BOOTSTRAP = 'TEST_NATIVE_V2_REVIEW_BOOTSTRAP';
export const V2_REVIEW_SUBJECT = 'TEST_NATIVE_V2_REVIEW_WORK';
export const V2_REVIEW_TOOL_PREFIX = 'TEST_NATIVE_V2_REVIEW_work_';
type Row = Record<string, unknown>;
function content(message: Row): string {
  if (typeof message.content === 'string') return message.content;
  return Array.isArray(message.content) ? message.content.map(record)
    .filter(part => part.type === 'text').map(part => String(part.text)).join('\n') : '';
}
function emit(response: ServerResponse, id: string, delta: Row, tool: boolean) {
  const event = (value: Row, finish: string | null) => ({ id,
    object: 'chat.completion.chunk', created: 1700000000, model: 'TEST-model',
    choices: [{ index: 0, delta: value, finish_reason: finish }] });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify(event(delta, null))}\n\n`);
  response.write(`data: ${JSON.stringify(event({}, tool ? 'tool_calls' : 'stop'))}\n\n`);
  response.end('data: [DONE]\n\n');
}

/** Local inference only. Original V2 tools and Host MCP own every Task and file effect. */
export async function startOpenCodeV2ReviewModel(options: {
  workspace(): string;
  principalId(): string;
}) {
  const observations: { turn: 'bootstrap' | 'work'; step: number; model: string; tools: string[] }[] = [];
  const probes: { model: string; tools: number }[] = [], failures: string[] = [];
  const counts = new Map<string, number>();
  let taskId = '';
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(failures.length, 0, 'oracle seals after the first rejected request');
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const raw of request) {
        const chunk = Buffer.from(raw as Uint8Array); bytes += chunk.length;
        assert.ok(bytes <= 2_000_000); chunks.push(chunk);
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      assert.equal(body.model, 'TEST-model');
      const messages = (Array.isArray(body.messages) ? body.messages : []).map(record);
      const users = messages.filter(row => row.role === 'user');
      const tools = (Array.isArray(body.tools) ? body.tools : []).map(record)
        .map(row => String(record(row.function).name));
      if (isOpenCodeModelProbe(body, 'v2')) {
        assert.ok(probes.length < 8);
        probes.push({ model: 'TEST-model', tools: 0 });
        emit(response, `TEST-v2-review-probe-${probes.length}`, { role: 'assistant', content: 'OK' }, false);
        return;
      }
      assert.ok(JSON.stringify(messages).includes(CONTEXT_MARKER), 'captured native member instructions');
      const selected = users.toReversed().map(content).find(text =>
        text.includes(V2_REVIEW_SUBJECT) || text.includes(V2_REVIEW_BOOTSTRAP));
      assert.ok(selected, 'only original Launch or original user Task Start');
      const turn = selected.includes(V2_REVIEW_SUBJECT) ? 'work' : 'bootstrap';
      const step = counts.get(turn) ?? 0;
      assert.ok(step <= (turn === 'work' ? 3 : 1), 'finite native conversation, no replay');
      const file = join(options.workspace(), 'native-review.ts');
      if (step > 0) {
        const result = messages.findLast(row => row.role === 'tool');
        assert.ok(result, 'native result precedes the next model continuation');
        if (turn === 'bootstrap') {
          const receipt = nativeToolReceipt(result.content);
          assert.equal(receipt.phase, 'completed');
          assert.equal(receipt.principalId, options.principalId());
          taskId = String(record(receipt.effects).taskId);
          assert.ok(taskId && taskId !== 'undefined');
        } else if (step === 1) {
          const output = JSON.stringify(result.content);
          assert.ok(output.includes('TEST pre-existing dirty content') && output.includes('const first = 1;'));
        } else assert.ok(JSON.stringify(result.content).includes('Edited'), 'actual native edit result');
      }
      if (turn === 'work') assert.ok(taskId, 'Task was created by original MCP before user Start');
      const actions = turn === 'bootstrap' ? [{ name: 'task_create', input: {
        commandId: 'TEST-native-v2-review-create', subject: V2_REVIEW_SUBJECT, owner: 'alice',
      } }] : [
        { name: 'read', input: { path: file } },
        { name: 'edit', input: { path: file, oldString: 'const first = 1;', newString: 'const first = 2;', replaceAll: false } },
        { name: 'edit', input: { path: file, oldString: 'const last = 1;', newString: 'const last = 2;', replaceAll: false } },
      ];
      const action = actions[step];
      observations.push({ turn, step, model: 'TEST-model', tools }); counts.set(turn, step + 1);
      if (!action) {
        emit(response, `TEST-v2-review-${turn}-${step}`, { role: 'assistant', content: `DONE_TEST_NATIVE_V2_REVIEW_${turn}` }, false);
        return;
      }
      const name = tools.find(value => action.name === 'task_create'
        ? [`agent-teams_${action.name}`, `mcp__agent-teams__${action.name}`].includes(value)
        : value === action.name);
      assert.ok(name, `original V2 catalog offers ${action.name}`);
      emit(response, `TEST-v2-review-${turn}-${step}`, { role: 'assistant', tool_calls: [{
        index: 0, id: `TEST_NATIVE_V2_REVIEW_${turn}_${step}`, type: 'function',
        function: { name, arguments: JSON.stringify(action.input) },
      }] }, true);
    })().catch(error => {
      failures.push(error instanceof Error ? error.message : 'TEST-review-oracle-failed');
      if (!response.headersSent) response.writeHead(400);
      response.end('TEST V2 review inference rejected request');
    });
  });
  server.requestTimeout = 15_000;
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, observations, probes, failures,
    taskId: () => taskId,
    close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }) };
}
