import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONTEXT_MARKER, nativeToolReceipt, record } from '../native-claude-team/model.ts';
import type { ServerResponse } from 'node:http';
type Row = Record<string, unknown>;
function emit(response: ServerResponse, id: number, blocks: Row[], model: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type: string, value: Row) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  event('message_start', { message: { id: `msg_host_evidence_${id}`, type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 0 } } });
  blocks.forEach((block, index) => {
    const tool = block.type === 'tool_use';
    event('content_block_start', { index, content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } });
    event('content_block_delta', { index, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
    event('content_block_stop', { index });
  });
  event('message_delta', { delta: { stop_reason: blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
  event('message_stop', {}); response.end();
}
export async function startEvidenceModel(root: string) {
  await mkdir(join(root, 'requests'));
  const observations: Row[] = [], failures: string[] = [];
  const counters = new Map<string, number>();
  let taskId = '';
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url?.includes('count_tokens')) { response.end('{"input_tokens":30}'); return; }
      assert.equal(failures.length, 0);
      assert.equal(request.method, 'POST'); assert.ok(request.url?.startsWith('/v1/messages'));
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const raw of request) { const chunk = Buffer.from(raw as Uint8Array); bytes += chunk.length; assert.ok(bytes < 2_000_000); chunks.push(chunk); }
      const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      assert.ok(observations.length < 12, 'finite inference request budget');
      await writeFile(join(root, 'requests', `${observations.length}.json`), JSON.stringify(body, null, 2));
      const messages = (body.messages as unknown[]).map(record);
      const tools = (body.tools as unknown[]).map(record).map(tool => String(tool.name));
      let turn = '';
      for (const message of messages.toReversed()) {
        if (message.role !== 'user') continue;
        const text = typeof message.content === 'string' ? message.content : (Array.isArray(message.content) ? message.content.map(record).filter(block => block.type === 'text').map(block => block.text).join('\n') : '');
        if (text.includes('NATIVE_CAPTURE_WORK')) { turn = 'work'; break; }
        if (text.includes('NATIVE_CAPTURE_BOOTSTRAP')) { turn = 'bootstrap'; break; }
      }
      assert.ok(turn, 'actual model input contains deliberate TEST task/message marker');
      const step = counters.get(turn) ?? 0;
      assert.ok(JSON.stringify(body.system).includes(CONTEXT_MARKER));
      const results = messages.flatMap(message => Array.isArray(message.content) ? message.content.map(record).filter(block => block.type === 'tool_result') : []);
      const last = results.at(-1);
      if (turn === 'bootstrap' && step === 1) {
        const receipt = nativeToolReceipt(last?.content);
        assert.equal(receipt.phase, 'completed'); assert.equal(receipt.principalId, 'alice-session');
        taskId = String(record(receipt.effects).taskId); assert.ok(taskId && taskId !== 'undefined');
      }
      if (turn === 'work' && step === 1) assert.equal(last?.is_error, true, 'actual failed Bash result');
      if (turn === 'work' && [2, 3, 4].includes(step)) assert.notEqual(last?.is_error, true);
      observations.push({ turn, step, at: Date.now(), lastResult: last, tools, model: body.model });
      counters.set(turn, step + 1);
      const tool = (id: string, name: string, input: Row): Row => { assert.ok(tools.includes(name), name); return { type: 'tool_use', id, name, input }; };
      let blocks: Row[];
      if (turn === 'bootstrap') blocks = step === 0 ? [tool('capture_mcp_create', 'mcp__team__task_create', { commandId: 'TEST-native-capture-create', subject: 'NATIVE_CAPTURE_WORK', owner: 'alice' })] : [{ type: 'text', text: 'DONE_CAPTURE_BOOTSTRAP' }];
      else {
        const actions: Row[][] = [
          [tool('capture_failed_bash', 'Bash', { command: "printf 'FAILED\\n' >> dirty.txt; exit 7", description: 'TEST failed foreground write' })],
          [tool('capture_read', 'Read', { file_path: join(root, 'workspace/dirty.txt') })],
          [tool('capture_edit', 'Edit', { file_path: join(root, 'workspace/dirty.txt'), old_string: 'FAILED\n', new_string: 'EDITED\n' })],
          [tool('capture_write', 'Write', { file_path: join(root, 'workspace/write-target.txt'), content: 'WRITE\n' })],
          [tool('capture_background', 'Bash', { command: "sleep 0.4; printf 'BACKGROUND\\n' > background.txt", run_in_background: true, description: 'TEST explicitly unqualified background' })],
          [tool('capture_overlap_a', 'Bash', { command: "printf 'A\\n' > overlap-a.txt", description: 'TEST first grouped effect' }), tool('capture_overlap_b', 'Bash', { command: "printf 'B\\n' > overlap-b.txt", description: 'TEST second grouped effect' })],
        ];
        blocks = actions[step] ?? [{ type: 'text', text: 'DONE_CAPTURE_WORK' }];
      }
      emit(response, observations.length, blocks, String(body.model));
    })().catch(error => { failures.push(String(error)); if (!response.headersSent) response.writeHead(400); response.end('TEST oracle rejected request'); });
  });
  server.requestTimeout = 15000;
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, observations, failures, taskId: () => taskId,
    close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }) };
}
