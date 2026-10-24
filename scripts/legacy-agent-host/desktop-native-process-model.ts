import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import {
  CONTEXT_MARKER,
  nativeToolReceipt,
  record,
} from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';

import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
type Model = Awaited<ReturnType<typeof startNativeTeamModel>>;
export const PROCESS_BOOTSTRAP = 'TEST_NATIVE_PROCESS_BOOTSTRAP';
export const PROCESS_REGISTER_ID = 'TEST-native-process-register-original';
export const PROCESS_LABEL = 'TEST native-owned primary service';
export interface Service {
  role: string;
  nonce: string;
  pid: number;
  port: number;
  url: string;
}
function emit(
  response: ServerResponse,
  sequence: number,
  block: Record<string, unknown>,
  model: string
) {
  const tool = block.type === 'tool_use';
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type: string, value: Record<string, unknown>) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  event('message_start', {
    message: {
      id: `msg_process_${sequence}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 30, output_tokens: 0 },
    },
  });
  event('content_block_start', {
    index: 0,
    content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' },
  });
  event('content_block_delta', {
    index: 0,
    delta: tool
      ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
      : { type: 'text_delta', text: block.text },
  });
  event('content_block_stop', { index: 0 });
  event('message_delta', {
    delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 20 },
  });
  event('message_stop', {});
  response.end();
}
/** Three finite responses; actual signed SDK executes Bash and the advertised private MCP catalog. */
export async function startProcessModel(options: {
  bashCommand(): string;
  services(): Promise<{ primary: Service; neighbor: Service }>;
}): Promise<Model & { rawTurns: Record<string, unknown>[] }> {
  const observations: Model['observations'] = [],
    failures: string[] = [];
  const rawTurns: Record<string, unknown>[] = [];
  let registerTool = '';
  const server = createServer((req, res) => {
    void (async () => {
      assert.equal(failures.length, 0, 'sealed oracle never replays after uncertain input');
      if (req.url?.includes('count_tokens')) {
        res.end('{"input_tokens":30}');
        return;
      }
      assert.equal(req.method, 'POST');
      assert.ok(req.url?.startsWith('/v1/messages'));
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const raw of req) {
        const b = Buffer.from(raw as Uint8Array);
        bytes += b.length;
        assert.ok(bytes < 2_000_000);
        chunks.push(b);
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      assert.ok(JSON.stringify(body.system).includes(CONTEXT_MARKER));
      const messages = (Array.isArray(body.messages) ? body.messages : []).map(record);
      assert.ok(JSON.stringify(messages).includes(PROCESS_BOOTSTRAP));
      const tools = (Array.isArray(body.tools) ? body.tools : []).map(record);
      const names = tools.map((t) => String(t.name));
      const bash = tools.filter((t) => t.name === 'Bash');
      const registration = tools.filter(
        (t) => typeof t.name === 'string' && t.name.endsWith('__process_register')
      );
      assert.equal(bash.length, 1);
      assert.equal(registration.length, 1, 'one actual advertised member process catalog');
      const requireField = (tool: Record<string, unknown>, key: string, kind: string) =>
        assert.equal(
          record(record(tool.input_schema).properties)[key] &&
            record(record(record(tool.input_schema).properties)[key]).type,
          kind
        );
      requireField(bash[0]!, 'command', 'string');
      requireField(registration[0]!, 'commandId', 'string');
      requireField(registration[0]!, 'pid', 'integer');
      requireField(registration[0]!, 'label', 'string');
      if (registerTool) assert.equal(registration[0]!.name, registerTool);
      registerTool = String(registration[0]!.name);
      const results = messages.flatMap((m) =>
        Array.isArray(m.content)
          ? m.content.map(record).filter((b) => b.type === 'tool_result')
          : []
      );
      const step = observations.length,
        last = results.at(-1);
      assert.ok(step < 3, 'only original Bash, original registration, terminal response');
      if (step > 0) assert.notEqual(last?.is_error, true, 'actual native tool action succeeds');
      let action: { name: string; input: Record<string, unknown> } | undefined;
      if (step === 0) {
        assert.equal(results.length, 0);
        action = {
          name: 'Bash',
          input: {
            command: options.bashCommand(),
            description: 'Start two finite TEST services in inherited native session',
            timeout: 15000,
          },
        };
      } else if (step === 1) {
        assert.equal(last?.tool_use_id, 'TEST_process_tool_0');
        const { primary, neighbor } = await options.services();
        assert.notEqual(primary.pid, neighbor.pid);
        action = {
          name: registerTool,
          input: {
            commandId: PROCESS_REGISTER_ID,
            pid: primary.pid,
            label: PROCESS_LABEL,
            port: primary.port,
            url: primary.url,
            command: 'TEST finite original native-owned service',
          },
        };
      } else {
        assert.equal(last?.tool_use_id, 'TEST_process_tool_1');
        const receipt = nativeToolReceipt(last?.content);
        assert.equal(receipt.commandId, PROCESS_REGISTER_ID);
        assert.equal(receipt.phase, 'completed');
        const result = record(receipt.result);
        assert.equal(result.observation, 'same-live');
        assert.equal(
          result.canTerminate,
          true,
          'actual provider root permission/session qualification, no PID fallback'
        );
        assert.match(String(result.processRef), /^p1:/);
      }
      rawTurns.push({
        step,
        tools,
        priorToolResult: last ?? null,
        requestedModel: body.model,
        outputConfig: body.output_config ?? null,
      });
      assert.equal(typeof body.model, 'string');
      observations.push({
        step,
        tools: names,
        requestedModel: String(body.model),
        turn: PROCESS_BOOTSTRAP,
        contextEffective: true,
        priorTurn: false,
        toolResultError: last?.is_error === true,
        visibleReplyContract: false,
        ...(typeof record(body.output_config).effort === 'string'
          ? { requestedEffort: String(record(body.output_config).effort) }
          : {}),
      });
      const model = String(body.model);
      emit(
        res,
        step + 1,
        action
          ? { type: 'tool_use', id: `TEST_process_tool_${step}`, ...action }
          : { type: 'text', text: 'TEST_PROCESS_REGISTERED' },
        model
      );
    })().catch((error) => {
      failures.push(error instanceof Error ? error.message : 'oracle rejected');
      if (!res.headersSent) res.writeHead(400);
      res.end('TEST process oracle rejected; no replay');
    });
  });
  server.requestTimeout = 15000;
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    compactionRequests: [], compactionTokenRequests: 0,
    url: `http://127.0.0.1:${address.port}`,
    observations,
    rawTurns,
    probes: [],
    ordinaryRequests: [],
    unexpectedNoToolsRequests: [],
    failures,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
