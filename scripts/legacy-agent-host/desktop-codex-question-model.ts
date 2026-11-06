import assert from "node:assert/strict";
import { createServer } from "node:http";
import { realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { codexToolReceipt } from "../../packages/legacy-agent-host/tests/fixtures/native-codex-team/model.ts";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Row;
};
export const CODEX_QUESTION_TURNS = [
  "CODEX_QUESTION_ALLOW",
  "CODEX_QUESTION_DENY",
] as const;
export const CODEX_QUESTION_TEXT = "Choose TEST color";
export const CODEX_QUESTION_ANSWER = "TEST_BLUE";
const body = async (request: IncomingMessage): Promise<Row> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.from(raw as Uint8Array);
    size += chunk.length;
    assert.ok(size <= 2_000_000);
    chunks.push(chunk);
  }
  return row(JSON.parse(Buffer.concat(chunks).toString("utf8")));
};
const reply = (response: ServerResponse, id: unknown, result: unknown) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
};
const event = (response: ServerResponse, frame: Row) =>
  response.write(`event: message\ndata: ${JSON.stringify(frame)}\n\n`);

/** TEST-only bounded inference plus selected MCP. Native Codex owns the elicitation bridge. */
export async function startDesktopCodexQuestionModel() {
  const failures: string[] = [],
    observations: Row[] = [],
    questionReceipts: Row[] = [],
    elicitationRequests: Row[] = [];
  let evidenceRoot: string | undefined;
  const counts = new Map<string, number>();
  const pending = new Map<
    string,
    { response: ServerResponse; callId: unknown; turn: string }
  >();
  let calls = 0;
  const mcp = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET") {
        response.writeHead(405);
        response.end();
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(204);
        response.end();
        return;
      }
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/mcp");
      const value = await body(request);
      if (value.method === undefined) {
        const original = pending.get(String(value.id));
        assert.ok(
          original,
          "only the original outstanding native elicitation reply",
        );
        const result = row(value.result);
        assert.ok(
          Object.keys(result).every((key) =>
            ["action", "content", "_meta"].includes(key),
          ),
        );
        assert.ok(result._meta === undefined || result._meta === null);
        assert.deepEqual(
          { action: result.action, content: result.content ?? null },
          original.turn === CODEX_QUESTION_TURNS[0]
            ? { action: "accept", content: { color: CODEX_QUESTION_ANSWER } }
            : { action: "decline", content: null },
        );
        questionReceipts.push({
          requestId: value.id,
          turn: original.turn,
          result,
        });
        pending.delete(String(value.id));
        response.writeHead(202);
        response.end();
        event(original.response, {
          jsonrpc: "2.0",
          id: original.callId,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ turn: original.turn, ...result }),
              },
            ],
          },
        });
        original.response.end();
        return;
      }
      if (value.method === "notifications/initialized") {
        response.writeHead(202);
        response.end();
        return;
      }
      if (value.method === "initialize") {
        // The actual client must advertise form elicitation; do not fabricate a bridge.
        assert.ok(
          row(row(value.params).capabilities).elicitation !== undefined,
        );
        reply(response, value.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "TEST-finite-question", version: "1" },
        });
        return;
      }
      if (value.method === "tools/list") {
        reply(response, value.id, {
          tools: [
            {
              name: "finite_question",
              description: "TEST finite color question",
              inputSchema: {
                type: "object",
                properties: {
                  turn: { type: "string", enum: CODEX_QUESTION_TURNS },
                },
                required: ["turn"],
                additionalProperties: false,
              },
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: false,
              },
            },
          ],
        });
        return;
      }
      assert.equal(value.method, "tools/call");
      const params = row(value.params);
      assert.equal(params.name, "finite_question");
      const turn = String(row(params.arguments).turn);
      assert.equal(turn, CODEX_QUESTION_TURNS[calls++]);
      assert.equal(pending.size, 0, "one original question at a time");
      const id = `TEST-native-question-${calls}`;
      pending.set(id, { response, callId: value.id, turn });
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const elicitation = {
        jsonrpc: "2.0",
        id,
        method: "elicitation/create",
        params: {
          mode: "form",
          message: CODEX_QUESTION_TEXT,
          requestedSchema: {
            type: "object",
            properties: {
              color: {
                type: "string",
                title: "color",
                enum: [CODEX_QUESTION_ANSWER, "TEST_GREEN"],
              },
            },
            required: ["color"],
          },
        },
      };
      elicitationRequests.push({ turn, callId: value.id, request: elicitation });
      event(response, elicitation);
    })().catch((error) => {
      failures.push(
        error instanceof Error ? error.message : "TEST MCP refused",
      );
      if (!response.headersSent) response.writeHead(400);
      response.end("TEST finite MCP refused");
    });
  });
  const model = createServer((request, response) => {
    void (async () => {
      assert.equal(
        failures.length,
        0,
        "seal model after original fixture failure",
      );
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/responses");
      const value = await body(request);
      assert.ok(Array.isArray(value.input) && Array.isArray(value.tools));
      const input = value.input.map(row);
      const source = input
        .toReversed()
        .find(
          (item) =>
            item.role === "user" &&
            CODEX_QUESTION_TURNS.some((turn) =>
              JSON.stringify(item.content).includes(turn),
            ),
        );
      assert.ok(source);
      const turn = CODEX_QUESTION_TURNS.find((turn) =>
        JSON.stringify(source.content).includes(turn),
      )!;
      const step = counts.get(turn) ?? 0;
      assert.ok(
        step <= 2,
        "one native question and canonical reply followed by terminal text, no replay",
      );
      assert.ok(
        JSON.stringify([
          value.instructions,
          input.filter((item) => item.role === "developer"),
        ]).includes("TEST_CODEX_QUESTION_CONTEXT"),
      );
      const tools = value.tools.flatMap((raw) => {
        const tool = row(raw);
        return tool.type === "namespace" && Array.isArray(tool.tools)
          ? tool.tools.map((child) => ({ ...row(child), namespace: tool.name }))
          : [tool];
      });
      let output: Row;
      if (step === 0) {
        const selected = tools.filter((tool) =>
          String(tool.name).endsWith("finite_question"),
        );
        assert.equal(selected.length, 1, "one actual captured finite MCP tool");
        const selectedTool = selected[0]!;
        output = {
          type: "function_call",
          call_id: `TEST-${turn}`,
          name: selectedTool.name,
          ...(selectedTool.namespace
            ? { namespace: selectedTool.namespace }
            : {}),
          arguments: JSON.stringify({ turn }),
        };
      } else if (step === 1) {
        assert.equal(
          questionReceipts.filter((receipt) => receipt.turn === turn).length,
          1,
        );
        const result = input
          .filter((item) => item.type === "function_call_output")
          .at(-1);
        assert.ok(result && JSON.stringify(result.output).includes(turn));
        const selected = tools.filter(
          (tool) =>
            (tool.name === "message_send" &&
              String(tool.namespace).includes("team")) ||
            String(tool.name).endsWith("team__message_send"),
        );
        assert.equal(selected.length, 1);
        const selectedTool = selected[0]!;
        output = {
          type: "function_call",
          call_id: `TEST-reply-${turn}`,
          name: selectedTool.name,
          ...(selectedTool.namespace
            ? { namespace: selectedTool.namespace }
            : {}),
          arguments: JSON.stringify({
            commandId: `TEST-native-reply-${turn}`,
            to: "user",
            text: `DONE_${turn}`,
          }),
        };
      } else {
        const result = input
          .filter((item) => item.type === "function_call_output")
          .at(-1);
        assert.equal(codexToolReceipt(result?.output).phase, "completed");
        output = {
          type: "message",
          role: "assistant",
          id: `TEST-final-${turn}`,
          content: [{ type: "output_text", text: `DONE_${turn}` }],
        };
      }
      observations.push({
        turn,
        step,
        toolNames: tools.map((tool) => tool.name),
        output,
      });
      counts.set(turn, step + 1);
      const id = `TEST-question-response-${observations.length}`;
      const events = [
        { type: "response.created", response: { id } },
        { type: "response.output_item.done", item: output },
        {
          type: "response.completed",
          response: {
            id,
            usage: {
              input_tokens: 10,
              input_tokens_details: null,
              output_tokens: 10,
              output_tokens_details: null,
              total_tokens: 20,
            },
          },
        },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        events
          .map(
            (frame) =>
              `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
          )
          .join(""),
      );
    })().catch((error) => {
      failures.push(
        error instanceof Error ? error.message : "TEST model refused",
      );
      if (!response.headersSent) response.writeHead(400);
      response.end("TEST question inference refused");
    });
  });
  for (const server of [mcp, model]) {
    server.requestTimeout = 45_000;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
  }
  const url = (server: typeof model) => {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  };
  return {
    url: url(model),
    mcpUrl: url(mcp) + "/mcp",
    failures,
    observations,
    questionReceipts,
    retainEvidenceAt: async (root: string) => {
      assert.equal(evidenceRoot, undefined, "one original TEST evidence root");
      assert.match(basename(root), /^TEST-desktop-backend-/);
      assert.equal(await realpath(root), root);
      evidenceRoot = root;
    },
    close: async () => {
      try {
        if (evidenceRoot)
          await writeFile(
            join(evidenceRoot, "codex-question-model.json"),
            JSON.stringify({
              schemaVersion: 1,
              phase: "before-model-close",
              root: evidenceRoot,
              failures,
              observations,
              elicitationRequests,
              questionReceipts,
              counts: Object.fromEntries(counts),
              calls,
              pending: [...pending].map(([id, value]) => ({
                id, callId: value.callId, turn: value.turn,
              })),
            }, null, 2),
            { mode: 0o600, flag: "wx" },
          );
      } finally {
        await Promise.all(
          [model, mcp].map(
            (server) =>
              new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
              }),
          ),
        );
      }
    },
  };
}
