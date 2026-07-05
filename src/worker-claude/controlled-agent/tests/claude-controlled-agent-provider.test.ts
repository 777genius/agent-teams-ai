import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultRedactor, type RunnerPort } from "@vioxen/subscription-runtime/core";
import {
  sessionArtifactFromClaudeOAuth,
  type ClaudeTaskEngineInput,
  type ClaudeTaskExecutionEngine,
  type ClaudeTaskExecutionResult,
} from "@vioxen/subscription-runtime/provider-claude";
import {
  AccessBoundary,
  ControlledAgentRunStatus,
  RunEventProviderKind,
  type ControlledAgentProviderStartInput,
} from "@vioxen/subscription-runtime/worker-core";
import {
  buildClaudeControlledAgentProfile,
  ClaudeControlledAgentProvider,
} from "../index";

describe("ClaudeControlledAgentProvider", () => {
  it("starts a strict broker-only Claude controller with no raw host tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-controlled-agent-provider-"));
    const engine = new RecordingClaudeEngine();
    const profile = buildClaudeControlledAgentProfile({
      stateDir: join(root, "state"),
      mcpCommand: "subscription-runtime-codex-goal-mcp-test",
      mcpArgs: ["--stdio"],
      mcpCwd: "/tmp/runtime",
    });
    const provider = new ClaudeControlledAgentProvider({
      profile,
      sessionArtifact: sessionArtifactFromClaudeOAuth({
        oauthToken: "claude-oauth-secret",
      }),
      workspacePath: join(root, "workspace"),
      engine,
      runner: new UnusedRunner(),
      redactor: new DefaultRedactor(),
      model: "sonnet",
      maxTurns: 1,
      controllerObjective: "Create child workers only through project broker tools.",
    });

    try {
      const start = provider.start(startInput());
      expect(start.providerRunId).toBe("session-1:claude-cli");
      expect(start.safeMessage).toContain("strict MCP broker tools");

      await waitForProviderStatus(
        () => provider.status({
          session: startInput().session,
          run: runningRun(),
        }),
        ControlledAgentRunStatus.Completed,
      );

      expect(engine.records[0]).toMatchObject({
        model: "sonnet",
        maxTurns: 1,
        workspacePath: join(root, "workspace"),
        allowedTools: profile.allowedTools,
        disallowedTools: profile.disallowedTools,
        mcpConfig: [profile.mcpConfig],
        strictMcpConfig: true,
        editMode: "allow-edits",
      });
      expect(engine.records[0]?.allowedTools).toContain(
        "mcp__subscription_runtime_project_control__codex_goal_project_start",
      );
      expect(engine.records[0]?.allowedTools).not.toContain("Bash");
      expect(engine.records[0]?.disallowedTools).toEqual(
        expect.arrayContaining(["Bash", "Edit", "Write", "Read", "Task"]),
      );
      expect(engine.records[0]?.session.configDir).toBe(profile.configDir);
      expect(engine.records[0]?.prompt).toContain(
        "Create child workers only through project broker tools.",
      );
      expect(engine.records[0]?.appendSystemPrompt).toContain(
        "Use only the configured MCP broker/status tools.",
      );
    } finally {
      await provider.stop({
        session: startInput().session,
        run: runningRun(),
      });
      await rm(root, { recursive: true, force: true });
    }
  });
});

class RecordingClaudeEngine implements ClaudeTaskExecutionEngine {
  readonly kind = "recording-claude-controlled-agent";
  readonly capabilities = {
    supportsStreaming: false,
    supportsToolCalls: false,
    supportsUsage: false,
    supportsProviderRunId: true,
    supportsCleanup: true,
  };
  readonly records: ClaudeTaskEngineInput[] = [];

  async run(input: ClaudeTaskEngineInput): Promise<ClaudeTaskExecutionResult> {
    this.records.push(input);
    return {
      outputText: "CLAUDE_CONTROLLED_AGENT_OK",
      telemetry: {
        providerRunId: "claude-controlled-test-run",
      },
      warnings: [],
    };
  }
}

class UnusedRunner implements RunnerPort {
  readonly runnerId = "unused-runner";
  readonly capabilities = {
    runnerId: this.runnerId,
    supportsEnvAllowlist: true,
    supportsWorkingDirectory: true,
    supportsTimeout: true,
    supportsAbortSignal: true,
    supportsOutputRedaction: false,
    supportsReadOnlySandbox: false,
    readOnlyFilesystem: false,
    platform: "node-process" as const,
  };

  async run(): Promise<never> {
    throw new Error("unused_runner_called");
  }
}

function startInput(): ControlledAgentProviderStartInput {
  return {
    session: {
      schemaVersion: 1,
      sessionId: "session-1",
      identity: {
        controllerJobId: "controller-1",
        projectId: "project-1",
        providerKind: RunEventProviderKind.Claude,
      },
      stateDir: "/tmp/state",
      status: ControlledAgentRunStatus.Planned,
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z",
      toolSurface: {
        boundary: AccessBoundary.ProjectScopedControl,
        allowedTools: [],
        deniedRawCapabilities: ["raw_shell", "raw_git", "raw_tmux"],
      },
    },
    systemPrompt: "Use only broker tools.",
  };
}

function runningRun() {
  return {
    schemaVersion: 1 as const,
    runId: "run-1",
    sessionId: "session-1",
    controllerJobId: "controller-1",
    providerKind: RunEventProviderKind.Claude as const,
    status: ControlledAgentRunStatus.Running,
    providerRunId: "session-1:claude-cli",
    startedAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
  };
}

async function waitForProviderStatus(
  readStatus: () => { readonly status: ControlledAgentRunStatus },
  expected: ControlledAgentRunStatus,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (readStatus().status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(readStatus().status).toBe(expected);
}
