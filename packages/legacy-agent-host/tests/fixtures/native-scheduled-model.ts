import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { codeModeCall, object, uiPalette } from './native-codex-team/responses-ui.ts';
import type { ServerResponse } from 'node:http';

type Row = Record<string, unknown>;
export type ScheduledNativeMode = 'success' | 'turn-limit' | 'budget' | 'cancel';
const marker = (mode: ScheduledNativeMode) => `TEST_SCHEDULE_NATIVE_${mode}`;
export const scheduledNativePrompt = (mode: ScheduledNativeMode) =>
  `${marker(mode)}. Follow the TEST native tool instruction, then return its result.`;

function claudeReply(response: ServerResponse, id: string, block: Row) {
  const tool = block.type === 'tool_use';
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type: string, value: Row) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  emit('message_start', { message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } });
  emit('content_block_start', { index: 0, content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } });
  emit('content_block_delta', { index: 0, delta: tool
    ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
    : { type: 'text_delta', text: block.text } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 15 } });
  emit('message_stop', {}); response.end();
}

function codexReply(response: ServerResponse, id: string, item: Row) {
  const events = [{ type: 'response.created', response: { id } },
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { id, usage: { input_tokens: 20,
      input_tokens_details: null, output_tokens: 15, output_tokens_details: null, total_tokens: 35 } } }];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

/** Scripts only model responses. The captured native CLI must execute and report every tool. */
export async function startScheduledNativeModel(provider: 'claude' | 'codex') {
  const counts = new Map<ScheduledNativeMode, number>();
  const failures: string[] = [];
  const requests: { mode: ScheduledNativeMode; model: unknown; effort?: unknown; serviceTier?: unknown }[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, 'POST');
      const chunks: Buffer[] = []; let size = 0;
      for await (const raw of request) {
        const chunk = Buffer.from(raw); size += chunk.length;
        assert.ok(size <= 1024 * 1024, 'bounded native TEST model request'); chunks.push(chunk);
      }
      const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (provider === 'claude' && request.url?.startsWith('/v1/messages/count_tokens')) {
        response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":20}'); return;
      }
      assert.ok(request.url?.startsWith(provider === 'claude' ? '/v1/messages' : '/v1/responses'));
      assert.equal(body.model, provider === 'claude' ? 'claude-sonnet-4-6' : 'mock-model');
      if (provider === 'codex') assert.equal(object(body.reasoning).effort, 'low');
      const serialized = JSON.stringify(provider === 'claude' ? body.messages : body.input);
      const modes = (['success', 'turn-limit', 'budget', 'cancel'] as const).filter(mode => serialized.includes(marker(mode)));
      assert.equal(modes.length, 1, 'one original scheduled input');
      const mode = modes[0]!, count = (counts.get(mode) ?? 0) + 1;
      assert.ok(count <= 4, 'native limits must stop the tool loop'); counts.set(mode, count);
      requests.push({ mode, model: body.model, ...(body.reasoning ? { effort: object(body.reasoning).effort } : {}),
        ...(body.service_tier === undefined ? {} : { serviceTier: body.service_tier }) });
      if (mode === 'cancel') return; // The actual client remains in flight until original Host cancellation.
      const command = `printf '%s\\n' 'TEST_NATIVE_TOOL' >> 'schedule-${mode}.txt'; cat 'schedule-${mode}.txt'`;
      const id = `TEST-schedule-${provider}-${mode}-${count}`;
      if (mode === 'success' && count > 1) {
        const toolId = `TEST-schedule-${provider}-${mode}-1-tool`;
        const output = provider === 'claude'
          ? (Array.isArray(body.messages) ? body.messages : []).map(object)
            .flatMap(message => Array.isArray(message.content) ? message.content.map(object) : [])
            .find(block => block.type === 'tool_result' && block.tool_use_id === toolId)
          : (Array.isArray(body.input) ? body.input : []).map(object)
            .find(item => ['function_call_output', 'custom_tool_call_output'].includes(String(item.type)) && item.call_id === toolId);
        assert.ok(output, 'original native tool result is correlated by its exact call ID');
        assert.notEqual(output.is_error, true);
        assert.match(JSON.stringify(provider === 'claude' ? output.content : output.output), /TEST_NATIVE_TOOL/,
          'actual native tool output returns to the model');
        if (provider === 'claude') claudeReply(response, id, { type: 'text', text: 'TEST_SCHEDULE_DONE' });
        else codexReply(response, id, { type: 'message', role: 'assistant', id: `${id}-text`,
          content: [{ type: 'output_text', text: 'TEST_SCHEDULE_DONE' }] });
        return;
      }
      if (provider === 'claude') {
        assert.ok(Array.isArray(body.tools) && body.tools.some(raw => object(raw).name === 'Bash'));
        claudeReply(response, id, { type: 'tool_use', id: `${id}-tool`, name: 'Bash',
          input: { command, description: 'Write the private TEST schedule marker' } });
      } else {
        const palette = uiPalette(body), input = { cmd: command, max_output_tokens: 1000, yield_time_ms: 1000 };
        const tool = palette.tools.find(value => value.name === 'exec_command');
        assert.ok(palette.exec || tool, 'actual native shell tool is advertised');
        codexReply(response, id, palette.exec
          ? codeModeCall(palette.exec, { name: 'exec_command', input }, `${id}-tool`)
          : { type: 'function_call', call_id: `${id}-tool`, name: tool!.name,
              ...(tool!.namespace ? { namespace: tool!.namespace } : {}), arguments: JSON.stringify(input) });
      }
    })().catch(error => {
      failures.push(String(error)); if (!response.headersSent) response.writeHead(400); response.end('TEST scenario rejected');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, counts, failures, requests,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
