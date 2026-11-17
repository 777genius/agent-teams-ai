/** TEST-only finite inference. Product files and tool effects belong to the real native processes. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { nativeToolReceipt, record } from '../native-claude-team/model.ts';
import { isOpenCodeModelProbe } from '../native-opencode-team/model-probe.ts';

export type McpTurn = 'ALLOW' | 'APP_ONLY';
export const mcpTurnText = (turn: McpTurn) => 'TEST_NATIVE_MCP_' + turn;
export async function startCapturedMcpModel(options: {
  nonce: string;
  originalInstance(): string;
  principalId?(turn: McpTurn): string;
  allowModelProbes?: boolean;
}) {
  const requests: { turn: McpTurn; step: number; tool: string | null }[] = [];
  const failures: string[] = [];
  const probes: { requestedModel: string }[] = [];
  const counts = new Map<McpTurn, number>();
  const server = createServer((request, response) => {
    void (async () => {
      assert.deepEqual(failures, []);
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const raw of request) {
        const chunk = Buffer.from(raw as Uint8Array);
        bytes += chunk.length;
        assert.ok(bytes <= 2_000_000);
        chunks.push(chunk);
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      assert.equal(body.model, 'TEST-model');
      if (options.allowModelProbes && isOpenCodeModelProbe(body, 'v2')) {
        assert.ok(probes.length < 8, 'same bounded original-dialog no-tool model probes');
        probes.push({ requestedModel: 'TEST-model' });
        const event = (delta: Record<string, unknown>, finish: string | null) => ({
          id: 'TEST-mcp-probe-' + probes.length, object: 'chat.completion.chunk',
          created: 1700000000, model: 'TEST-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: ' + JSON.stringify(event({ role: 'assistant', content: 'OK' }, null)) + '\n\n');
        response.write('data: ' + JSON.stringify(event({}, 'stop')) + '\n\n');
        response.end('data: [DONE]\n\n');
        return;
      }
      const messages = (Array.isArray(body.messages) ? body.messages : []).map(record);
      const marker = messages.toReversed().filter(row => row.role === 'user')
        .map(row => /TEST_NATIVE_MCP_(ALLOW|APP_ONLY)/.exec(JSON.stringify(row.content)))
        .find(Boolean);
      assert.ok(marker);
      const turn = marker[1] as McpTurn;
      const step = counts.get(turn) ?? 0;
      assert.ok(step <= (turn === 'ALLOW' ? 2 : 1) && requests.length < 5,
        'finite original input and native tool continuations only');
      const tools = (Array.isArray(body.tools) ? body.tools : []).map(record)
        .map(tool => String(record(tool.function).name));
      assert.deepEqual(tools.filter(name => name.startsWith('TEST_')).sort(),
        turn === 'ALLOW' ? ['TEST_selected_write_marker'] : [],
        'exact captured namespace is exposed only to the allowlisted member');
      assert.equal(tools.some(name => /excluded/i.test(name)), false);
      const teamTool = tools.find(name =>
        ['agent-teams_message_send', 'mcp__agent-teams__message_send'].includes(name));
      assert.ok(teamTool, 'original Team MCP remains available for both policies');
      if (turn === 'ALLOW' && step === 1) {
        const output = JSON.stringify(messages.filter(row => row.role === 'tool').at(-1)?.content);
        assert.ok(options.originalInstance());
        assert.ok(output.includes('TEST_EXTERNAL_MCP_EFFECT:' + options.nonce + ':' + options.originalInstance()),
          'actual external tool result carries the captured native process instance');
      }
      const teamStep = turn === 'ALLOW' ? 1 : 0;
      if (step === teamStep + 1) {
        const receipt = nativeToolReceipt(messages.filter(row => row.role === 'tool').at(-1)?.content);
        assert.equal(receipt.phase, 'completed');
        assert.equal(receipt.principalId, options.principalId?.(turn) ??
          (turn === 'ALLOW' ? 'allow' : 'app-only') + '-session');
      }
      const action = turn === 'ALLOW' && step === 0
        ? { name: 'TEST_selected_write_marker', input: { nonce: options.nonce } }
        : step === teamStep
          ? { name: teamTool, input: { commandId: 'TEST-mcp-native-reply-' + turn,
              to: 'user', text: 'REPLY_NATIVE_MCP_' + turn } }
          : undefined;
      counts.set(turn, step + 1);
      requests.push({ turn, step, tool: action?.name ?? null });
      const delta = action ? { tool_calls: [{ index: 0, id: 'TEST-mcp-call-' + turn + '-' + step,
        type: 'function', function: { name: action.name, arguments: JSON.stringify(action.input) } }] }
        : { role: 'assistant', content: 'TEST_DONE_' + turn };
      const event = (value: unknown, finish: string | null) => ({
        id: 'TEST-mcp-inference-' + turn + '-' + step, object: 'chat.completion.chunk',
        created: 1700000000, model: 'TEST-model',
        choices: [{ index: 0, delta: value, finish_reason: finish }],
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify(event(delta, null)) + '\n\n');
      response.write('data: ' + JSON.stringify(event({}, action ? 'tool_calls' : 'stop')) + '\n\n');
      response.end('data: [DONE]\n\n');
    })().catch(error => {
      failures.push(error instanceof assert.AssertionError
        ? 'TEST_captured_mcp_oracle_assertion' : 'TEST_captured_mcp_oracle_request');
      if (!response.headersSent) response.writeHead(400);
      response.end('TEST captured MCP oracle refused');
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: 'http://127.0.0.1:' + address.port, requests, failures, probes,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    },
  };
}
