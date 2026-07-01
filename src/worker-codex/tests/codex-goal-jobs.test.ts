import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexGoalJobManifestPath,
  codexGoalJobToArgs,
  codexGoalJobManifestSchemaVersion,
  createCodexGoalJob,
  listCodexGoalJobs,
  readCodexGoalJob,
  summarizeCodexGoalJob,
  updateCodexGoalJob,
  type CodexGoalJobManifestInput,
} from "../codex-goal-jobs";

describe("codex goal job registry", () => {
  it("creates, lists, reads, updates and summarizes versioned job manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-jobs-"));
    const registryRootDir = join(root, "registry");
    const manifestInput = jobManifest(root);

    try {
      const created = await createCodexGoalJob({
        registryRootDir,
        manifest: manifestInput,
        now: new Date("2026-06-01T00:00:00.000Z"),
      });
      const manifestPath = codexGoalJobManifestPath({
        registryRootDir,
        jobId: manifestInput.jobId,
      });

      expect(created).toMatchObject({
        schemaVersion: codexGoalJobManifestSchemaVersion,
        jobId: "job-a",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      });
      expect(summarizeCodexGoalJob(created, registryRootDir)).toMatchObject({
        jobId: "job-a",
        manifestPath,
        accountNames: ["account-a", "account-b"],
      });

      const listed = await listCodexGoalJobs({ registryRootDir });
      expect(listed.map((job) => job.jobId)).toEqual(["job-a"]);
      await expect(readCodexGoalJob({
        registryRootDir,
        jobId: "job-a",
      })).resolves.toEqual(created);

      const updated = await updateCodexGoalJob({
        registryRootDir,
        jobId: "job-a",
        patch: {
          description: "updated",
          tags: ["cat1", "recall"],
          taskTimeoutMs: 42_000,
        },
        now: new Date("2026-06-01T00:10:00.000Z"),
      });

      expect(updated.description).toBe("updated");
      expect(updated.tags).toEqual(["cat1", "recall"]);
      expect(updated.taskTimeoutMs).toBe(42_000);
      expect(updated.createdAt).toBe(created.createdAt);
      expect(updated.updatedAt).toBe("2026-06-01T00:10:00.000Z");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("converts a manifest to launch-compatible args without schema metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-jobs-"));

    try {
      const manifest = await createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: jobManifest(root),
      });
      const args = codexGoalJobToArgs(manifest);

      expect(args).toMatchObject({
        jobRootDir: manifest.jobRootDir,
        authRootDir: manifest.authRootDir,
        workspacePath: manifest.workspacePath,
        promptPath: manifest.promptPath,
        taskId: "task-a",
        accounts: ["account-a", "account-b"],
        model: "gpt-5.5",
        reasoningEffort: "xhigh",
        serviceTier: "fast",
        workerReportMode: "structured-output",
      });
      expect(args).not.toHaveProperty("schemaVersion");
      expect(args).not.toHaveProperty("createdAt");
      expect(args).not.toHaveProperty("updatedAt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe job ids and empty account lists", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-jobs-"));

    try {
      await expect(createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: {
          ...jobManifest(root),
          jobId: "../bad",
        },
      })).rejects.toThrow("codex_goal_job_id_invalid");

      await expect(createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: {
          ...jobManifest(root),
          accounts: [],
        },
      })).rejects.toThrow("codex_goal_job_accounts_required");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsupported codex goal control mode combinations", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-jobs-"));

    try {
      const { editMode: _editMode, ...legacyManifest } = jobManifest(root);
      await expect(createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: {
          ...legacyManifest,
          permissionMode: "danger-full-access" as never,
        } as unknown as CodexGoalJobManifestInput,
      })).rejects.toThrow(/Use providerSandboxMode/);

      const created = await createCodexGoalJob({
        registryRootDir: join(root, "registry"),
        manifest: jobManifest(root),
      });
      await expect(updateCodexGoalJob({
        registryRootDir: join(root, "registry"),
        jobId: created.jobId,
        patch: {
          editMode: "read-only",
          providerSandboxMode: "danger-full-access",
        },
      })).rejects.toThrow(/requires editMode "allow-edits"/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function jobManifest(root: string): CodexGoalJobManifestInput {
  return {
    jobId: "job-a",
    description: "sandbox job",
    tags: ["locomo"],
    jobRootDir: join(root, "job"),
    authRootDir: join(root, "auth"),
    stateRootDir: join(root, "state"),
    workspacePath: join(root, "workspace"),
    promptPath: join(root, "job", "prompt.md"),
    taskId: "task-a",
    accounts: ["account-a", "account-b"],
    outputPath: join(root, "job", "task-a.latest-result.json"),
    codexBinaryPath: "codex",
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
    serviceTier: "fast",
    taskTimeoutMs: 72 * 60 * 60 * 1000,
    maxAccountCycles: 3,
    editMode: "allow-edits",
    allowDuplicateAccountIdentities: false,
    requireGitWorkspace: true,
    prewarmOnStart: false,
    workerReportMode: "structured-output",
    tmuxSession: "job-a",
    cwd: root,
    logPath: join(root, "job", "task-a.log"),
    outputFormat: "json",
  };
}
