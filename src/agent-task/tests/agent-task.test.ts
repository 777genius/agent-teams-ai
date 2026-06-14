import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderTaskEvent } from "@vioxen/subscription-runtime/core";
import {
  agentTaskProtocolVersion,
  agentTaskRoundMemberFingerprint,
  assertAgentTaskCertification,
  certifyAgentTaskExchange,
  compareAgentTaskRoundMembers,
  createAgentTaskRequest,
  loadAgentTaskHandler,
  parseAgentTaskEvent,
  parseAgentTaskRequest,
  parseAgentTaskResult,
  runAgentTaskBridge,
  runAgentTaskCli,
  streamAgentTaskBridge,
} from "../index";

describe("agent-task JSON adapter kit", () => {
  it("normalizes request JSON and maps it to a provider-neutral handler", async () => {
    const request = createAgentTaskRequest({
      runId: "run-1",
      providerInstanceId: "provider:test",
      cwd: "/workspace",
      timeoutMs: 30_000,
      task: {
        kind: "structured-prompt",
        prompt: "Return OK.",
        systemPrompt: "System rules stay separate.",
        controls: {
          model: "test-model",
          responseFormat: "json",
          outputSchema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
          },
        },
        metadata: { app: "qa-rig" },
      },
      context: {
        application: "qa-rig",
        purpose: "triage",
        correlationId: "corr-1",
        round: {
          roundId: "review-round-1",
          roundIndex: 1,
          totalRounds: 3,
          member: {
            id: "critic-codex",
            adapterId: "subscription-runtime-codex",
            agentType: "critic",
            provider: "openai",
            model: "gpt-5.5",
            independenceGroup: "openai:gpt-5.5",
          },
          adversaryOf: {
            id: "advocate-claude",
            adapterId: "subscription-runtime-claude",
            agentType: "advocate",
            provider: "anthropic",
            model: "sonnet",
            independenceGroup: "anthropic:sonnet",
          },
        },
      },
    });

    expect(parseAgentTaskRequest(request)).toMatchObject({
      protocolVersion: agentTaskProtocolVersion,
      task: {
        kind: "structured-prompt",
        prompt: "Return OK.",
        systemPrompt: "System rules stay separate.",
      },
      context: {
        round: {
          member: {
            id: "critic-codex",
          },
        },
      },
    });

    const run = await runAgentTaskBridge(request, async (received) => ({
      status: "completed",
      outputText: `handled:${received.task.systemPrompt}:${received.task.prompt}`,
      structuredOutput: { ok: true },
      telemetry: {
        turns: 1,
        cost: { amount: 0.01, currency: "USD" },
      },
      warnings: [],
    }));

    expect(run.result).toMatchObject({
      protocolVersion: agentTaskProtocolVersion,
      status: "completed",
      outputText: "handled:System rules stay separate.:Return OK.",
      structuredOutput: { ok: true },
    });
    expect(run.events.map((event) => event.type)).toEqual([
      "started",
      "completed",
    ]);
  });

  it("normalizes provider stream events into JSON-safe bridge events", async () => {
    const request = createAgentTaskRequest({
      task: {
        kind: "review",
        prompt: "Review this diff.",
      },
    });

    async function* streamTask(): AsyncIterable<ProviderTaskEvent> {
      yield {
        type: "started",
        occurredAt: new Date("2026-06-13T12:00:00.000Z"),
      };
      yield {
        type: "text_delta",
        occurredAt: new Date("2026-06-13T12:00:01.000Z"),
        text: "No findings.",
      };
      yield {
        type: "completed",
        occurredAt: new Date("2026-06-13T12:00:02.000Z"),
        result: {
          status: "completed",
          outputText: "No findings.",
          warnings: [],
        },
      };
    }

    const run = await runAgentTaskBridge(request, { streamTask });

    expect(run.result).toMatchObject({
      status: "completed",
      outputText: "No findings.",
    });
    expect(run.events.map((event) => event.type)).toEqual([
      "started",
      "text_delta",
      "completed",
    ]);
    expect(run.events[0]?.occurredAt).toBe("2026-06-13T12:00:00.000Z");
  });

  it("rejects oversized task system prompts before provider dispatch", () => {
    expect(() =>
      parseAgentTaskRequest({
        protocolVersion: agentTaskProtocolVersion,
        task: {
          kind: "review",
          prompt: "Review this diff.",
          systemPrompt: "x".repeat(256 * 1024 + 1),
        },
      }),
    ).toThrow("request.task.systemPrompt exceeds 262144 bytes");
  });

  it("turns an unterminated provider stream into a failed terminal event", async () => {
    const request = createAgentTaskRequest({
      task: {
        kind: "review",
        prompt: "Review this diff.",
      },
    });

    async function* streamTask(): AsyncIterable<ProviderTaskEvent> {
      yield {
        type: "text_delta",
        occurredAt: new Date("2026-06-13T12:00:01.000Z"),
        text: "partial",
      };
    }

    const run = await runAgentTaskBridge(request, { streamTask });

    expect(run.result).toMatchObject({
      status: "failed",
      failure: { code: "provider_output_invalid" },
    });
    expect(run.events.map((event) => event.type)).toEqual([
      "started",
      "text_delta",
      "completed",
    ]);
    expect(() =>
      assertAgentTaskCertification({
        request,
        result: run.result,
        events: run.events,
        requireTerminalEvent: true,
      }),
    ).not.toThrow();
  });

  it("uses completed events emitted through stream context as the terminal result", async () => {
    const request = createAgentTaskRequest({
      task: {
        kind: "review",
        prompt: "Review this diff.",
      },
    });

    const run = await runAgentTaskBridge(request, {
      async *streamTask(_received, context) {
        await context.emit({
          type: "completed",
          occurredAt: new Date("2026-06-13T12:00:02.000Z"),
          result: {
            status: "completed",
            outputText: "context emitted result",
            warnings: [],
          },
        });
      },
    });

    expect(run.result).toMatchObject({
      status: "completed",
      outputText: "context emitted result",
    });
    expect(run.events.map((event) => event.type)).toEqual(["completed"]);
    expect(() =>
      assertAgentTaskCertification({
        request,
        result: run.result,
        events: run.events,
        requireTerminalEvent: true,
      }),
    ).not.toThrow();
  });

  it("streams emitted events before the task completes", async () => {
    const request = createAgentTaskRequest({
      task: {
        kind: "structured-prompt",
        prompt: "stream",
      },
    });
    let releaseTask!: () => void;
    const taskGate = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const iterator = streamAgentTaskBridge(
      request,
      async (_received, context) => {
        await context.emit({
          type: "text_delta",
          occurredAt: new Date("2026-06-13T12:00:01.000Z"),
          text: "partial",
        });
        await taskGate;
        return {
          status: "completed",
          outputText: "done",
          warnings: [],
        };
      },
      { now: () => new Date("2026-06-13T12:00:00.000Z") },
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "started" },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "text_delta", text: "partial" },
    });

    releaseTask();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "completed", result: { outputText: "done" } },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("rejects unsupported telemetry and tool-call enum values", () => {
    expect(() =>
      parseAgentTaskResult({
        protocolVersion: agentTaskProtocolVersion,
        status: "completed",
        outputText: "x",
        telemetry: { finishReason: "made_up" },
        warnings: [],
      }),
    ).toThrow("telemetry.finishReason is unsupported");

    expect(() =>
      parseAgentTaskEvent({
        protocolVersion: agentTaskProtocolVersion,
        type: "tool_call",
        occurredAt: "2026-06-13T12:00:00.000Z",
        toolCall: {
          name: "read",
          status: "made_up",
        },
      }),
    ).toThrow("event.toolCall.status is unsupported");
  });

  it("certifies round member identity and adversarial independence", async () => {
    const request = createAgentTaskRequest({
      task: {
        kind: "structured-prompt",
        prompt: "Judge the prior round.",
      },
      context: {
        round: {
          member: {
            id: "critic-codex",
            adapterId: "subscription-runtime-codex",
            agentType: "critic",
            provider: "openai",
            model: "gpt-5.5",
            independenceGroup: "openai:gpt-5.5",
          },
          adversaryOf: {
            id: "advocate-claude",
            adapterId: "subscription-runtime-claude",
            agentType: "advocate",
            provider: "anthropic",
            model: "sonnet",
            independenceGroup: "anthropic:sonnet",
          },
        },
      },
    });
    const run = await runAgentTaskBridge(request, async () => ({
      status: "completed",
      outputText: "independent",
      warnings: [],
    }));

    expect(() =>
      assertAgentTaskCertification({
        request,
        result: run.result,
        events: run.events,
        requireRoundMemberIdentity: true,
        requireRoundMemberIndependence: true,
        requireTerminalEvent: true,
      }),
    ).not.toThrow();

    expect(agentTaskRoundMemberFingerprint(request.context!.round!.member)).toBe(
      "12:critic-codex|26:subscription-runtime-codex|6:critic|6:openai|7:gpt-5.5|14:openai:gpt-5.5",
    );
  });

  it("rejects round members that are not adversarially independent", () => {
    const member = {
      id: "critic-a",
      adapterId: "subscription-runtime-claude",
      agentType: "critic",
      provider: "anthropic",
      model: "sonnet",
      independenceGroup: "anthropic:sonnet",
    };
    const sameModel = {
      ...member,
      id: "advocate-a",
      agentType: "advocate",
    };
    const sameGroup = {
      ...member,
      id: "advocate-b",
      agentType: "advocate",
      model: "opus",
    };

    expect(compareAgentTaskRoundMembers(member, sameModel)).toMatchObject({
      ok: false,
      failure: "same-provider-model",
    });
    expect(compareAgentTaskRoundMembers(member, sameGroup)).toMatchObject({
      ok: false,
      failure: "same-independence-group",
    });
  });

  it("loads a handler module and drives it through the CLI bridge", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-task-cli-"));
    try {
      const handlerPath = join(tempDir, "handler.mjs");
      const requestPath = join(tempDir, "request.json");
      await writeFile(
        handlerPath,
        [
          "export async function runAgentTask(request) {",
          "  return {",
          "    protocolVersion: 1,",
          "    status: 'completed',",
          "    outputText: `cli:${request.task.prompt}`,",
          "    warnings: []",
          "  };",
          "}",
        ].join("\n"),
      );
      await writeFile(
        requestPath,
        JSON.stringify(
          createAgentTaskRequest({
            task: {
              kind: "structured-prompt",
              prompt: "hello",
            },
          }),
        ),
      );

      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runAgentTaskCli(
        [
          "--handler",
          handlerPath,
          "--input",
          requestPath,
          "--format",
          "result-json",
        ],
        {
          readStdin: async () => "",
          writeStdout: (chunk) => stdout.push(chunk),
          writeStderr: (chunk) => stderr.push(chunk),
          cwd: () => tempDir,
        },
      );

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        status: "completed",
        outputText: "cli:hello",
      });
      await expect(loadAgentTaskHandler(handlerPath)).resolves.toBeTypeOf(
        "function",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("certifies terminal event consistency and catches output secret leaks", async () => {
    const request = createAgentTaskRequest({
      task: {
        kind: "structured-prompt",
        prompt: "Summarize failure.",
      },
    });
    const run = await runAgentTaskBridge(request, async () => ({
      status: "completed",
      outputText: "safe summary",
      warnings: [],
    }));

    expect(() =>
      assertAgentTaskCertification({
        request,
        result: run.result,
        events: run.events,
        forbiddenSecrets: ["secret-token"],
        requireTerminalEvent: true,
      }),
    ).not.toThrow();

    const failed = certifyAgentTaskExchange({
      request,
      result: {
        ...run.result,
        outputText: "leaked secret-token",
      },
      events: run.events,
      forbiddenSecrets: ["secret-token"],
    });

    expect(failed.status).toBe("failed");
    expect(failed.checks).toContainEqual(
      expect.objectContaining({
        name: "secret-redaction",
        status: "failed",
      }),
    );
  });
});
