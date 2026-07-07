import { describe, expect, it } from "vitest";
import {
  codexAppServerSandboxPolicy,
  codexAppServerThreadRuntimePolicy,
  codexExtraWritableRootsFromEnv,
  mergeDeveloperInstructions,
} from "../codex-app-server-policy";
import { readGoal } from "../codex-app-server-protocol";

describe("Codex app-server boundary helpers", () => {
  it("builds a strict workspace-write sandbox policy from the scoped environment", () => {
    expect(
      codexAppServerSandboxPolicy({
        sandboxMode: "workspace-write",
        workspacePath: "/work/repo",
        sourceEnv: {
          SUBSCRIPTION_RUNTIME_CODEX_EXTRA_WRITABLE_ROOTS:
            " /cache/a :/cache/a,\n/cache/b ",
        },
      }),
    ).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/work/repo", "/cache/a", "/cache/b"],
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
    });
  });

  it("suppresses inherited extra writable roots when the scoped runtime requests it", () => {
    expect(
      codexExtraWritableRootsFromEnv({
        SUBSCRIPTION_RUNTIME_CODEX_SUPPRESS_EXTRA_WRITABLE_ROOTS: "1",
        SUBSCRIPTION_RUNTIME_CODEX_EXTRA_WRITABLE_ROOTS: "/outside",
      }),
    ).toEqual([]);
  });

  it("builds the app-server thread runtime policy before execution starts", () => {
    expect(
      codexAppServerThreadRuntimePolicy({
        workspacePath: "/work/repo",
        sourceEnv: {
          SUBSCRIPTION_RUNTIME_CODEX_EXTRA_WRITABLE_ROOTS:
            " /cache/a :/cache/a,\n/cache/b ",
        },
        baseDeveloperInstructions: "base instructions",
        systemPrompt: "  task instructions  ",
      }),
    ).toEqual({
      runtimeWorkspaceRoots: ["/work/repo", "/cache/a", "/cache/b"],
      sandboxMode: "read-only",
      developerInstructions: "base instructions\n\ntask instructions",
    });
  });

  it("keeps task system prompts in developer instructions without changing empty prompts", () => {
    expect(
      mergeDeveloperInstructions({
        base: "base instructions",
        systemPrompt: "  task instructions  ",
      }),
    ).toBe("base instructions\n\ntask instructions");
    expect(
      mergeDeveloperInstructions({
        base: "base instructions",
        systemPrompt: "   ",
      }),
    ).toBe("base instructions");
  });

  it("normalizes app-server goal records and rejects unknown goal states", () => {
    expect(
      readGoal({
        threadId: "thread-1",
        objective: "finish the task",
        status: "usageLimited",
        usage: {
          input_tokens: 12,
          output_tokens: 8,
        },
      }),
    ).toEqual({
      threadId: "thread-1",
      objective: "finish the task",
      status: "usageLimited",
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
      },
    });
    expect(
      readGoal({
        threadId: "thread-1",
        objective: "finish the task",
        status: "done",
      }),
    ).toBeNull();
  });
});
