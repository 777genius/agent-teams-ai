/** TEST-only finite inference oracle. Only the real engine can read/write fixture files. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { record } from './native-claude-team/model.ts';

export const permissionTurns = ['DENY', 'ONCE', 'REJECT', 'REVOKE', 'ACTIVE', 'SIBLING'] as const;
export type PermissionTurn = (typeof permissionTurns)[number];
export const outsideSecret = 'TEST_NATIVE_EXTERNAL_CONTENT_ONLY_AFTER_ONCE';
export const turnText = (turn: PermissionTurn) => 'TEST_V2_PERMISSION_' + turn;

export async function startPermissionModel(options: { outsideFile: string }) {
  const counts = new Map<PermissionTurn, number>();
  const requests: {
    turn: PermissionTurn;
    step: number;
    tool: string | null;
    externalContent: boolean;
  }[] = [];
  const failures: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.deepEqual(failures, []);
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const raw of request) {
        const chunk = Buffer.from(raw as Uint8Array);
        size += chunk.length;
        assert.ok(size <= 2_000_000);
        chunks.push(chunk);
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      assert.equal(body.model, 'TEST-model');
      const messages = (Array.isArray(body.messages) ? body.messages : []).map(record);
      let turn: PermissionTurn | undefined;
      for (const message of messages.toReversed()) {
        if (message.role !== 'user') continue;
        const match = /TEST_V2_PERMISSION_(DENY|ONCE|REJECT|REVOKE|ACTIVE|SIBLING)/.exec(
          JSON.stringify(message.content)
        );
        if (match) {
          turn = match[1] as PermissionTurn;
          break;
        }
      }
      assert.ok(turn, 'native request carries one deliberate permission scenario');
      const step = counts.get(turn) ?? 0;
      assert.ok(
        step <= (turn === 'SIBLING' ? 0 : 1),
        'no repeated native inference after a terminal or Stop'
      );
      assert.ok(requests.length < 12);
      const tools = (Array.isArray(body.tools) ? body.tools : [])
        .map(record)
        .map((tool) => String(record(tool.function).name));
      assert.equal(tools.includes('subagent'), false);
      assert.equal(tools.includes('execute'), false);
      const action = turn === 'SIBLING' || step !== 0 ? null : turn === 'ACTIVE' ? 'shell' : 'read';
      if (action)
        assert.ok(tools.includes(action), 'the real engine advertises the selected native tool');
      let externalContent = false;
      if (step === 1) {
        assert.ok(
          turn !== 'ACTIVE' && turn !== 'REVOKE',
          'revocation/active Stop cannot finish the blocked tool'
        );
        const output = JSON.stringify(
          messages.filter((message) => message.role === 'tool').at(-1)?.content
        );
        externalContent = output.includes(outsideSecret);
        assert.equal(
          externalContent,
          turn === 'ONCE',
          'only an accepted once grant can disclose the external file'
        );
      }
      counts.set(turn, step + 1);
      requests.push({ turn, step, tool: action, externalContent });
      const input =
        action === 'read'
          ? { path: options.outsideFile }
          : {
              command:
                "printf '%s\\n' \"$$\" > active.pid; printf 'START\\n' > active-started.txt; sleep 30; printf 'LATE\\n' > active-late.txt",
              timeout: 60_000,
            };
      const delta = action
        ? {
            tool_calls: [
              {
                index: 0,
                id: 'TEST-permission-' + turn,
                type: 'function',
                function: { name: action, arguments: JSON.stringify(input) },
              },
            ],
          }
        : { role: 'assistant', content: 'TEST_DONE_' + turn };
      const event = (value: unknown, finish: string | null) => ({
        id: 'TEST-native-permission-' + turn + '-' + step,
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: 'TEST-model',
        choices: [{ index: 0, delta: value, finish_reason: finish }],
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify(event(delta, null)) + '\n\n');
      response.write('data: ' + JSON.stringify(event({}, action ? 'tool_calls' : 'stop')) + '\n\n');
      response.end('data: [DONE]\n\n');
    })().catch((error) => {
      failures.push(
        error instanceof assert.AssertionError
          ? 'TEST_permission_model_assertion'
          : 'TEST_permission_model_request'
      );
      if (!response.headersSent) response.writeHead(400);
      response.end('TEST permission model refused');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: 'http://127.0.0.1:' + address.port,
    requests,
    failures,
    counts,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done()))
      );
    },
  };
}
