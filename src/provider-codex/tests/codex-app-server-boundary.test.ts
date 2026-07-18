import { describe, expect, it } from "vitest";
import {
  codexAppServerSandboxPolicy,
  codexAppServerThreadRuntimePolicy,
  codexAgentTempRootFromEnv,
  codexAgentTempWritableRootsFromEnv,
  codexExtraWritableRootsFromEnv,
  mergeDeveloperInstructions,
} from "../codex-app-server-policy";
import { readGoal } from "../codex-app-server-protocol";
import {
  codexProviderApiEgressProfileId,
  codexProviderEgressEnv,
  codexProviderEgressProfileEnvVar,
} from "../codex-provider-egress-policy";

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

  it("enables app-server network access only for the generated provider egress profile", () => {
    const sourceEnv = codexProviderEgressEnv();
    expect(sourceEnv[codexProviderEgressProfileEnvVar]).toBe(
      codexProviderApiEgressProfileId,
    );
    expect(codexAppServerSandboxPolicy({
      sandboxMode: "read-only",
      workspacePath: "/work/repo",
      sourceEnv,
    })).toEqual({ type: "readOnly", networkAccess: true });
    expect(codexAppServerSandboxPolicy({
      sandboxMode: "workspace-write",
      workspacePath: "/work/repo",
      sourceEnv,
    })).toMatchObject({
      type: "workspaceWrite",
      writableRoots: ["/work/repo"],
      networkAccess: true,
    });
    expect(codexAppServerSandboxPolicy({
      sandboxMode: "workspace-write",
      workspacePath: "/work/repo",
      sourceEnv: { [codexProviderEgressProfileEnvVar]: "unknown-profile" },
    })).toMatchObject({
      type: "workspaceWrite",
      networkAccess: false,
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

  it("keeps only the exact agent scratch root writable for scoped workers", () => {
    const sourceEnv = {
      SUBSCRIPTION_RUNTIME_JOB_ROOT: "/jobs/job-1",
      SUBSCRIPTION_RUNTIME_TMPDIR: "/jobs/job-1/tmp",
      TMPDIR: "/jobs/job-1/tmp/agent",
      SUBSCRIPTION_RUNTIME_CODEX_SUPPRESS_EXTRA_WRITABLE_ROOTS: "1",
      SUBSCRIPTION_RUNTIME_CODEX_EXTRA_WRITABLE_ROOTS: "/outside",
    };
    expect(codexAgentTempRootFromEnv(sourceEnv)).toBe("/jobs/job-1/tmp/agent");
    expect(codexAgentTempWritableRootsFromEnv(sourceEnv)).toEqual([
      "/jobs/job-1/tmp/agent",
    ]);
    expect(codexAppServerSandboxPolicy({
      sandboxMode: "workspace-write",
      workspacePath: "/work/repo",
      sourceEnv,
    })).toMatchObject({
      writableRoots: ["/work/repo", "/jobs/job-1/tmp/agent"],
      excludeTmpdirEnvVar: false,
    });
    expect(codexAppServerThreadRuntimePolicy({
      workspacePath: "/work/repo",
      sandboxMode: "workspace-write",
      sourceEnv,
      baseDeveloperInstructions: null,
    })).toMatchObject({
      runtimeWorkspaceRoots: ["/work/repo", "/jobs/job-1/tmp/agent"],
    });
    expect(codexAppServerThreadRuntimePolicy({
      workspacePath: "/work/repo",
      sourceEnv,
      baseDeveloperInstructions: null,
    })).toMatchObject({ runtimeWorkspaceRoots: ["/work/repo"] });
  });

  it("rejects malformed or overbroad agent scratch roots", () => {
    const invalidEnvironments = [
      { SUBSCRIPTION_RUNTIME_JOB_ROOT: "/jobs/job-1", SUBSCRIPTION_RUNTIME_TMPDIR: "/jobs/job-1-evil/tmp", TMPDIR: "/jobs/job-1-evil/tmp/agent" },
      { SUBSCRIPTION_RUNTIME_JOB_ROOT: "/jobs/job-1", SUBSCRIPTION_RUNTIME_TMPDIR: "/jobs/job-1", TMPDIR: "/jobs/job-1/agent" },
      { SUBSCRIPTION_RUNTIME_JOB_ROOT: "/jobs/job-1", SUBSCRIPTION_RUNTIME_TMPDIR: "/jobs/job-1/tmp", TMPDIR: "/jobs/job-1/tmp" },
      { SUBSCRIPTION_RUNTIME_JOB_ROOT: "/jobs/job-1", SUBSCRIPTION_RUNTIME_TMPDIR: "/jobs/job-1/tmp", TMPDIR: "/jobs/job-1/tmp/agent/deeper" },
      { SUBSCRIPTION_RUNTIME_JOB_ROOT: "jobs/job-1", SUBSCRIPTION_RUNTIME_TMPDIR: "jobs/job-1/tmp", TMPDIR: "jobs/job-1/tmp/agent" },
    ];
    for (const sourceEnv of invalidEnvironments) {
      expect(codexAgentTempWritableRootsFromEnv(sourceEnv)).toEqual([]);
    }
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
