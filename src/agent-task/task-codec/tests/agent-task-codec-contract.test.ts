import { describe, expect, it } from "vitest";
import {
  agentTaskRequestToProviderTask,
  agentTaskResultToProviderTaskResult,
  parseAgentTaskRequest,
  parseAgentTaskResult,
  providerTaskResultToAgentTaskResult,
} from "../../codec";
import { compareAgentTaskRoundMembers } from "../../rounds";
import { agentTaskProtocolVersion } from "../../types";

describe("agent-task codec contract", () => {
  it("keeps request contracts JSON-safe while mapping only provider controls downstream", () => {
    const request = parseAgentTaskRequest({
      protocolVersion: agentTaskProtocolVersion,
      task: {
        kind: "structured-prompt",
        prompt: "Return a JSON object.",
        controls: {
          editMode: "allow-edits",
          providerSandboxMode: "workspace-write",
          responseFormat: "json",
          outputSchemaName: "answer",
          outputSchema: {
            type: "object",
            properties: {
              answer: { type: "string", description: undefined },
            },
            required: ["answer"],
          },
        },
      },
    });

    expect(request.task.controls?.outputSchema).toEqual({
      type: "object",
      properties: {
        answer: { type: "string" },
      },
      required: ["answer"],
    });
    expect(agentTaskRequestToProviderTask(request)).toEqual({
      kind: "structured-prompt",
      prompt: "Return a JSON object.",
      controls: {
        editMode: "allow-edits",
        providerSandboxMode: "workspace-write",
        responseFormat: "json",
        outputSchemaName: "answer",
      },
    });
  });

  it("round-trips waiting-for-input results through the provider result contract", () => {
    const agentResult = providerTaskResultToAgentTaskResult({
      status: "waiting_for_input",
      runId: "run-1",
      outputText: "Need a decision.",
      request: {
        id: "input-1",
        kind: "decision_required",
        question: "Continue?",
        audience: "orchestrator",
        suggestedAnswers: ["yes", "no"],
      },
      resumeHandle: {
        runId: "run-1",
        providerId: "provider-1",
        workspacePath: "/workspace",
      },
      warnings: [],
    });

    expect(parseAgentTaskResult(agentResult)).toEqual(agentResult);
    expect(agentTaskResultToProviderTaskResult(agentResult)).toEqual({
      status: "waiting_for_input",
      runId: "run-1",
      outputText: "Need a decision.",
      request: {
        id: "input-1",
        kind: "decision_required",
        question: "Continue?",
        audience: "orchestrator",
        suggestedAnswers: ["yes", "no"],
      },
      resumeHandle: {
        runId: "run-1",
        providerId: "provider-1",
        workspacePath: "/workspace",
      },
      warnings: [],
    });
  });

  it("rejects legacy or malformed codec inputs with protocol errors", () => {
    expect(() =>
      parseAgentTaskRequest({
        protocolVersion: agentTaskProtocolVersion + 1,
        task: {
          kind: "review",
          prompt: "Review this.",
        },
      }),
    ).toThrow("request.protocolVersion must be 1");

    expect(() =>
      parseAgentTaskResult({
        protocolVersion: agentTaskProtocolVersion,
        status: "completed",
        outputText: "bad",
        structuredOutput: Number.NaN,
        warnings: [],
      }),
    ).toThrow("result.structuredOutput must be a finite JSON number");
  });

  it("keeps round-member comparison available through compatibility imports", () => {
    expect(
      compareAgentTaskRoundMembers(
        {
          id: "critic",
          adapterId: "codex",
          agentType: "critic",
          provider: "openai",
          model: "gpt-5",
          independenceGroup: "openai:gpt-5",
        },
        {
          id: "advocate",
          adapterId: "claude",
          agentType: "advocate",
          provider: "anthropic",
          model: "sonnet",
          independenceGroup: "anthropic:sonnet",
        },
      ),
    ).toEqual({ ok: true });
  });
});
