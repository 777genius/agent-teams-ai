import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
interface NotificationAck {
  role: string;
  taskId: string;
  toolUseId: string;
  status: string;
  messageId: string;
  responseFinished: boolean;
  servicePid: number;
  exitReason: string;
}
export interface Service {
  role: string;
  nonce: string;
  pid: number;
  port: number;
  url: string;
}
export function qualifyNativeServiceCompletion(
  role: 'primary' | 'neighbor',
  service: Service,
  lifecycle: Record<string, unknown>[]
) {
  assert.equal(service.role, role);
  assert.ok(Number.isSafeInteger(service.pid) && service.pid > 1);
  assert.deepEqual(
    lifecycle.map((event) => event.event),
    ['listening', 'closing', 'closed']
  );
  assert.ok(
    lifecycle.every((event) => event.role === role && event.pid === service.pid),
    'same original role/PID lifecycle only'
  );
  assert.equal(lifecycle[0]!.ttlMs, 300_000);
  const exitReason = lifecycle[1]!.reason;
  assert.ok(exitReason === 'SIGTERM' || exitReason === 'natural-ttl');
  assert.equal(lifecycle[2]!.reason, exitReason);
  // Both pinned service handlers finish normally with process.exitCode=0.
  return {
    status: 'completed',
    ending: 'completed (exit code 0)',
    servicePid: service.pid,
    exitReason,
  };
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
/** Four finite responses; actual signed SDK executes Bash and the advertised private MCP catalog. */
export async function startProcessModel(options: {
  bashCommand(): string;
  services(): Promise<{ primary: Service; neighbor: Service }>;
  serviceLifecycle(role: 'primary' | 'neighbor'): Promise<Record<string, unknown>[]>;
}): Promise<
  Model & {
    rawTurns: Record<string, unknown>[];
    notificationAcks: NotificationAck[];
    backgroundTasks: {
      role: 'primary' | 'neighbor';
      taskId: string;
      toolUseId: string;
      outputFile: string;
    }[];
  }
> {
  const observations: Model['observations'] = [],
    failures: string[] = [];
  const rawTurns: Record<string, unknown>[] = [];
  const probes: Model['probes'] = [];
  const tasks: {
    role: 'primary' | 'neighbor';
    taskId: string;
    toolUseId: string;
    outputFile: string;
  }[] = [];
  let originalServices: { primary: Service; neighbor: Service } | undefined;
  const notificationAcks: NotificationAck[] = [];
  const wrapper = JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/process-notification-wrapper.json'), 'utf8')
  ) as { prefix: string; suffix: string };
  let registerTool = '';
  const server = createServer((req, res) => {
    void (async () => {
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
      // Retain this original request's tool result before any schema/success assertion.
      const rawMessages = (Array.isArray(body.messages) ? body.messages : []).map(record);
      const rawResults = rawMessages.flatMap((m) =>
        Array.isArray(m.content)
          ? m.content.map(record).filter((b) => b.type === 'tool_result')
          : []
      );
      const rawTurn = {
        step: observations.length,
        tools: body.tools,
        priorToolResult: rawResults.at(-1) ?? null,
        newestMessage: rawMessages.at(-1) ?? null,
        requestedModel: body.model,
        outputConfig: body.output_config ?? null,
      };
      rawTurns.push(rawTurn);
      assert.equal(failures.length, 0, 'sealed oracle never replays after uncertain input');
      const messages = (Array.isArray(body.messages) ? body.messages : []).map(record);
      const tools = (Array.isArray(body.tools) ? body.tools : []).map(record);
      const probeMessages = messages.filter((message) => message.role === 'user');
      const probeContent = probeMessages[0]?.content;
      const probeTexts =
        typeof probeContent === 'string'
          ? [probeContent]
          : Array.isArray(probeContent) &&
              probeContent.every(
                (block) => record(block).type === 'text' && typeof record(block).text === 'string'
              )
            ? probeContent.map((block) => String(record(block).text))
            : [];
      const textOnlySystem = (message: Record<string, unknown>) => {
        if (message.role !== 'system') return false;
        if (typeof message.content === 'string') return message.content.length <= 64 * 1024;
        return (
          Array.isArray(message.content) &&
          message.content.length > 0 &&
          message.content.length <= 8 &&
          message.content.every((raw) => {
            const block = record(raw);
            return (
              block.type === 'text' &&
              typeof block.text === 'string' &&
              block.text.length <= 64 * 1024
            );
          })
        );
      };
      // One exact SDK user input may have native reminders and text-only system transport wrappers.
      // Additional user, assistant, tool, or nontext system messages never qualify as a model probe.
      const probeText =
        messages.length <= 8 &&
        probeMessages.length === 1 &&
        messages.every((message) => message.role === 'user' || textOnlySystem(message))
          ? probeTexts
              .map((text) =>
                text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
              )
              .filter(Boolean)
              .join('\n')
          : undefined;
      if (
        probeText === 'Reply only OK. Do not use tools, access files or run commands.' &&
        tools.length === 0
      ) {
        assert.ok(probes.length < 8, 'finite native model probe request budget');
        probes.push({
          ...(typeof body.model === 'string' ? { requestedModel: body.model } : {}),
          ...(typeof record(body.output_config).effort === 'string'
            ? { requestedEffort: String(record(body.output_config).effort) }
            : {}),
        });
        emit(res, 100 + probes.length, { type: 'text', text: 'OK' }, String(body.model));
        return;
      }
      assert.ok(JSON.stringify(body.system).includes(CONTEXT_MARKER));
      assert.ok(JSON.stringify(messages).includes(PROCESS_BOOTSTRAP));
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
      requireField(bash[0]!, 'run_in_background', 'boolean');
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
      if (step === 4) {
        const newest = rawMessages.at(-1)!;
        assert.equal(newest.role, 'user');
        assert.ok(Array.isArray(newest.content));
        assert.equal(newest.content.length, 1);
        const block = record(newest.content[0]);
        assert.equal(block.type, 'text');
        const task = tasks.find(
          (row) =>
            typeof block.text === 'string' &&
            block.text.includes(`<task-id>${row.taskId}</task-id>`)
        );
        assert.ok(task, 'only a notification for an original native task is acknowledged');
        assert.ok(
          notificationAcks.length < 2 &&
            !notificationAcks.some((row) => row.taskId === task.taskId),
          'unknown/repeated notifications remain refused'
        );
        assert.ok(
          originalServices,
          'original service identities were captured before registration'
        );
        const completion = qualifyNativeServiceCompletion(
          task.role,
          originalServices[task.role],
          await options.serviceLifecycle(task.role)
        );
        const { status, ending } = completion;
        const expected = `${wrapper.prefix}<task-notification>\n<task-id>${task.taskId}</task-id>\n<tool-use-id>${task.toolUseId}</tool-use-id>\n<output-file>${task.outputFile}</output-file>\n<status>${status}</status>\n<summary>Background command "Run one finite foreground TEST HTTP server as a native background task" ${ending}</summary>\n</task-notification>${wrapper.suffix}`;
        assert.equal(
          block.text,
          expected,
          'exact original task/tool/status notification only; no new human input'
        );
        assert.equal(typeof body.model, 'string');
        const sequence = 4 + notificationAcks.length + 1;
        const ack: NotificationAck = {
          servicePid: completion.servicePid,
          exitReason: completion.exitReason,
          role: task.role,
          taskId: task.taskId,
          toolUseId: task.toolUseId,
          status,
          messageId: `msg_process_${sequence}`,
          responseFinished: false,
        };
        notificationAcks.push(ack);
        res.once('finish', () => {
          ack.responseFinished = true;
        });
        emit(
          res,
          sequence,
          { type: 'text', text: 'TEST_ORIGINAL_BACKGROUND_NOTIFICATION_ACKNOWLEDGED' },
          String(body.model)
        );
        return; // Text only: no native tool, new registration or input action.
      }
      assert.ok(
        step < 4,
        'only two original foreground background Bash calls, original registration, terminal response'
      );
      if (step > 0)
        assert.notEqual(
          last?.is_error,
          true,
          'every original native action must succeed for this qualification'
        );
      if (step === 1 || step === 2) {
        assert.equal(typeof last?.content, 'string');
        const match =
          /^Command running in background with ID: ([a-zA-Z0-9_-]+)\. Output is being written to: (\S+)\. You will be notified when it completes\./.exec(
            String(last!.content)
          );
        assert.ok(match, 'capture the original public native background task receipt');
        assert.ok(!tasks.some((row) => row.taskId === match[1]));
        assert.equal(last?.tool_use_id, `TEST_process_tool_${step - 1}`);
        tasks.push({
          role: step === 1 ? 'primary' : 'neighbor',
          taskId: match[1]!,
          outputFile: match[2]!,
          toolUseId: String(last!.tool_use_id),
        });
      }
      let action: { name: string; input: Record<string, unknown> } | undefined;
      if (step < 2) {
        if (step === 0) assert.equal(results.length, 0);
        else assert.equal(last?.tool_use_id, 'TEST_process_tool_0');
        action = {
          name: 'Bash',
          input: {
            command: `${options.bashCommand()} ${step === 0 ? 'primary' : 'neighbor'}`,
            description: 'Run one finite foreground TEST HTTP server as a native background task',
            run_in_background: true,
            timeout: 300000,
          },
        };
      } else if (step === 2) {
        assert.equal(last?.tool_use_id, 'TEST_process_tool_1');
        const { primary, neighbor } = await options.services();
        assert.notEqual(primary.pid, neighbor.pid);
        assert.equal(originalServices, undefined);
        originalServices = structuredClone({ primary, neighbor });
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
        assert.equal(last?.tool_use_id, 'TEST_process_tool_2');
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
          : { type: 'text', text: 'TEST_NATIVE_REGISTERED_FOR_ORIGINAL_HUMAN_STOP' },
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
    crossTeamRequests: [],
    compactionRequests: [],
    compactionTokenRequests: 0,
    url: `http://127.0.0.1:${address.port}`,
    observations,
    rawTurns,
    notificationAcks,
    backgroundTasks: tasks,
    probes,
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
