import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ProjectAdmissionDecisionStatus,
  ProjectAdmissionWorkerRole,
  ProjectOperation,
  consumedDebt,
  consumedOutputRecordFor,
  evaluateProjectAdmission,
} from "@vioxen/subscription-runtime/worker-core";
import { createLocalProjectIntegrationMcpToolHandlers } from "../project-integration-mcp/adapters/local-project-integration-mcp-tool-handlers";
import type { ProjectIntegrationMcpController } from "../project-integration-mcp";
import { readCodexGoalConsumedOutputLedgers } from "../application/project-control/codex-goal-consumed-output-ledger-io";
import { projectIntegrationPushApprovedCommitWithConsumedLedger } from "../codex-goal-mcp-project-integration-ledger";

const execFileAsync = promisify(execFile);

describe("project integration safety kernel e2e", () => {
  it("applies a preserved patch from registry jobs into an isolated worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-integration-preserved-patch-"));
    const projectRoot = join(root, "var", "data", "agent-teams-hosted-web-refactor");
    const worktreeRoot = join(projectRoot, "worktrees");
    const targetPath = join(worktreeRoot, "integration-hosted-web-feature-boundaries");
    const workerPath = join(worktreeRoot, "phase-0-worker-h6");
    const registryRootDir = join(projectRoot, "worker-jobs", "registry-v2");
    const jobsRoot = join(projectRoot, "worker-jobs", "jobs");
    const controllerRoot = join(jobsRoot, "controller-v2");
    const patchPath = join(jobsRoot, "phase-0-worker-h6", "worker.preserved.patch");

    try {
      await mkdir(targetPath, { recursive: true });
      await git(targetPath, ["init", "-b", "main"]);
      await git(targetPath, ["config", "user.name", "Seed"]);
      await git(targetPath, ["config", "user.email", "seed@example.com"]);
      await writeFile(join(targetPath, "feature.ts"), "export const value = 1;\n");
      await git(targetPath, ["add", "feature.ts"]);
      await git(targetPath, ["commit", "-m", "chore: seed synthetic project"]);
      await git(root, ["clone", targetPath, workerPath]);
      await writeFile(join(workerPath, "feature.ts"), "export const value = 2;\n");
      await mkdir(join(jobsRoot, "phase-0-worker-h6"), { recursive: true });
      await writeFile(patchPath, await gitOutput(workerPath, ["diff", "--binary"]));
      await mkdir(controllerRoot, { recursive: true });

      const baseCommit = (await gitOutput(targetPath, ["rev-parse", "HEAD"])).trim();
      const controller: ProjectIntegrationMcpController = {
        registryRootDir,
        controller: { jobId: "controller-v2", jobRootDir: controllerRoot },
        scope: {
          projectId: "agent-teams-hosted-web-refactor",
          workspaceRoots: [targetPath],
          worktreeRoots: [worktreeRoot],
          jobIdPrefixes: ["phase-0-"],
          allowedBranches: ["main"],
          allowedGitRemotes: ["origin"],
        },
      };
      const handlers = createLocalProjectIntegrationMcpToolHandlers({
        loadController: async () => controller,
        resolvePathArg: (_args, value, fieldName) => {
          if (typeof value !== "string" || !value) throw new Error(`${fieldName}_required`);
          return value;
        },
      });
      const args = {
        attemptId: "phase-0-attempt-h6",
        workerJobId: "phase-0-worker-h6",
        workerWorkspacePath: workerPath,
        workerPatchPath: patchPath,
        workerBaseCommit: baseCommit,
        targetCommit: baseCommit,
        baseStatus: "current",
        baseRevisionReasons: ["base-current"],
        targetWorkspacePath: targetPath,
        targetBranch: "main",
        targetRemote: "origin",
        changedFiles: ["feature.ts"],
        approvedFiles: ["feature.ts"],
        allowedPathPrefixes: ["feature.ts"],
        requiredCheckIds: [],
        requiredChecks: [],
        reviewedBy: "controller-v2",
        reviewReason: "focused preserved patch regression",
      } as const;

      await handlers.openAttempt({ ...args, confirmOpen: true });
      const applied = await handlers.applyWorkerOutput({ ...args, confirmApply: true });

      expect(applied.structuredContent).toMatchObject({ ok: true });
      expect(await readFile(join(targetPath, "feature.ts"), "utf8"))
        .toBe("export const value = 2;\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies, checks, commits, pushes, records and reopens producer admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-integration-safety-e2e-"));
    const remotePath = join(root, "remote.git");
    const seedPath = join(root, "seed");
    const targetPath = join(root, "target");
    const workerPath = join(root, "worker");
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerRoot = join(root, "worker-jobs", "controller-v1");
    const ledgerRoot = join(root, "control", "consumed-output-ledger");
    await git(root, ["init", "--bare", remotePath]);
    await mkdir(join(seedPath, "src"), { recursive: true });
    await git(seedPath, ["init", "-b", "main"]);
    await git(seedPath, ["config", "user.name", "Seed"]);
    await git(seedPath, ["config", "user.email", "seed@example.com"]);
    await writeFile(join(seedPath, "src", "feature.ts"), "export const value = 1;\n");
    await git(seedPath, ["add", "."]);
    await git(seedPath, ["commit", "-m", "chore: seed synthetic project"]);
    await git(seedPath, ["remote", "add", "origin", remotePath]);
    await git(seedPath, ["push", "-u", "origin", "main"]);
    await git(root, ["--git-dir", remotePath, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await git(root, ["clone", remotePath, targetPath]);
    await git(root, ["clone", remotePath, workerPath]);
    await mkdir(controllerRoot, { recursive: true });

    await writeFile(join(workerPath, "src", "feature.ts"), "export const value = 2;\n");
    const patchPath = join(workerPath, "worker-output.patch");
    await writeFile(patchPath, await gitOutput(workerPath, ["diff", "--binary"]));
    const baseCommit = (await gitOutput(targetPath, ["rev-parse", "HEAD"])).trim();
    const controller: ProjectIntegrationMcpController = {
      registryRootDir,
      controller: { jobId: "controller-v1", jobRootDir: controllerRoot },
      scope: {
        projectId: "synthetic-project",
        workspaceRoots: [targetPath, workerPath],
        consumedOutputLedgerRoots: [ledgerRoot],
        jobIdPrefixes: ["synthetic-"],
        commitIdentity: {
          name: "Approved Integrator",
          email: "integrator@example.com",
        },
        allowedBranches: ["main"],
        allowedGitRemotes: ["origin"],
      },
    };
    const loadController = async () => controller;
    const handlers = createLocalProjectIntegrationMcpToolHandlers({
      loadController,
      resolvePathArg: (_args, value, fieldName) => {
        if (typeof value !== "string" || !value) throw new Error(`${fieldName}_required`);
        return value;
      },
    });
    const args = {
      attemptId: "synthetic-attempt-1",
      workerJobId: "synthetic-worker-1",
      workerWorkspacePath: workerPath,
      workerPatchPath: patchPath,
      workerBaseCommit: baseCommit,
      targetCommit: baseCommit,
      baseStatus: "current",
      baseRevisionReasons: ["base-current"],
      targetWorkspacePath: targetPath,
      targetBranch: "main",
      targetRemote: "origin",
      changedFiles: ["src/feature.ts"],
      approvedFiles: ["src/feature.ts"],
      allowedPathPrefixes: ["src"],
      requiredCheckIds: ["synthetic-check"],
      requiredChecks: [{
        checkId: "synthetic-check",
        command: ["node", "-e", "process.exit(0)"],
      }],
      reviewedBy: "synthetic-controller",
      reviewReason: "synthetic e2e approval",
    } as const;

    await handlers.openAttempt({ ...args, confirmOpen: true });
    await handlers.applyWorkerOutput({ ...args, confirmApply: true });
    await handlers.runRequiredChecks({ ...args, confirmRunChecks: true });
    const committed = await handlers.commitApprovedChanges({
      ...args,
      message: "fix(synthetic): integrate worker output",
      confirmCommit: true,
    });
    expect(committed.structuredContent).toMatchObject({ ok: true });
    const pushed = await projectIntegrationPushApprovedCommitWithConsumedLedger({
      args: { ...args, confirmPush: true },
      loadController,
      pushApprovedCommitHandler: handlers.pushApprovedCommit,
    });
    expect(pushed.structuredContent).toMatchObject({
      ok: true,
    });
    expect(await gitOutput(root, [
      "--git-dir",
      remotePath,
      "show",
      "main:src/feature.ts",
    ])).toBe("export const value = 2;\n");
    expect(await gitOutput(targetPath, ["show", "-s", "--format=%an <%ae>"]))
      .toBe("Approved Integrator <integrator@example.com>\n");

    const ledger = await readCodexGoalConsumedOutputLedgers({ roots: [ledgerRoot] });
    const record = consumedOutputRecordFor({
      ledger,
      jobId: "synthetic-worker-1",
      workspacePath: workerPath,
    });
    expect(record).toMatchObject({ status: "integrated", valid: true });
    const admission = evaluateProjectAdmission({
      request: {
        operation: ProjectOperation.StartWorker,
        workerRole: ProjectAdmissionWorkerRole.Producer,
      },
      snapshot: {
        schemaVersion: 1,
        projectId: "synthetic-project",
        observedAt: new Date().toISOString(),
        debt: record ? consumedDebt(record) : [],
      },
    });
    expect(admission).toMatchObject({
      allowed: true,
      status: ProjectAdmissionDecisionStatus.Allowed,
    });

    const ledgerPath = join(ledgerRoot, "items", "synthetic-worker-1.json");
    expect(JSON.parse(await readFile(ledgerPath, "utf8"))).toMatchObject({
      jobId: "synthetic-worker-1",
      status: "integrated",
    });
  });

  it("archives rejected worker output and records valid terminal admission evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-integration-rejection-e2e-"));
    const targetPath = join(root, "target");
    const workerPath = join(root, "worker");
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerRoot = join(root, "worker-jobs", "controller-v1");
    const ledgerRoot = join(root, "control", "consumed-output-ledger");

    try {
      await mkdir(targetPath, { recursive: true });
      await git(targetPath, ["init", "-b", "main"]);
      await git(targetPath, ["config", "user.name", "Seed"]);
      await git(targetPath, ["config", "user.email", "seed@example.com"]);
      await writeFile(join(targetPath, "feature.ts"), "export const value = 1;\n");
      await git(targetPath, ["add", "feature.ts"]);
      await git(targetPath, ["commit", "-m", "chore: seed synthetic project"]);
      await git(root, ["clone", targetPath, workerPath]);
      await writeFile(join(workerPath, "feature.ts"), "export const value = 2;\n");
      const patchPath = join(workerPath, "worker-output.patch");
      await writeFile(patchPath, await gitOutput(workerPath, ["diff", "--binary"]));
      await mkdir(controllerRoot, { recursive: true });

      const baseCommit = (await gitOutput(targetPath, ["rev-parse", "HEAD"])).trim();
      const controller: ProjectIntegrationMcpController = {
        registryRootDir,
        controller: { jobId: "controller-v1", jobRootDir: controllerRoot },
        scope: {
          projectId: "synthetic-project",
          workspaceRoots: [targetPath, workerPath],
          consumedOutputLedgerRoots: [ledgerRoot],
          jobIdPrefixes: ["synthetic-"],
          allowedBranches: ["main"],
          allowedGitRemotes: ["origin"],
        },
      };
      const handlers = createLocalProjectIntegrationMcpToolHandlers({
        loadController: async () => controller,
        resolvePathArg: (_args, value, fieldName) => {
          if (typeof value !== "string" || !value) {
            throw new Error(`${fieldName}_required`);
          }
          return value;
        },
      });
      const args = {
        attemptId: "synthetic-rejected-attempt-1",
        workerJobId: "synthetic-rejected-worker-1",
        workerWorkspacePath: workerPath,
        workerPatchPath: patchPath,
        workerBaseCommit: baseCommit,
        targetCommit: baseCommit,
        baseStatus: "current",
        baseRevisionReasons: ["base-current"],
        targetWorkspacePath: targetPath,
        targetBranch: "main",
        targetRemote: "origin",
        changedFiles: ["feature.ts"],
        approvedFiles: ["feature.ts"],
        allowedPathPrefixes: ["feature.ts"],
        requiredCheckIds: [],
        requiredChecks: [],
        reviewedBy: "controller-v1",
        reviewReason: "synthetic rejection regression",
      } as const;

      await handlers.openAttempt({ ...args, confirmOpen: true });
      const rejected = await handlers.rejectAttempt({
        ...args,
        reason: "focused review rejected output",
        confirmReject: true,
      });
      expect(rejected.structuredContent).toMatchObject({
        ok: true,
        attempt: { status: "rejected" },
        consumedOutputLedger: {
          status: "rejected",
          ledgerPath: expect.any(String),
          archivePath: expect.any(String),
        },
      });

      const ledger = await readCodexGoalConsumedOutputLedgers({
        roots: [ledgerRoot],
      });
      const record = consumedOutputRecordFor({
        ledger,
        jobId: "synthetic-rejected-worker-1",
        workspacePath: workerPath,
      });
      expect(record).toMatchObject({ status: "rejected", valid: true });
      const admission = evaluateProjectAdmission({
        request: {
          operation: ProjectOperation.StartWorker,
          workerRole: ProjectAdmissionWorkerRole.Producer,
        },
        snapshot: {
          schemaVersion: 1,
          projectId: "synthetic-project",
          observedAt: new Date().toISOString(),
          debt: record ? consumedDebt(record) : [],
        },
      });
      expect(admission).toMatchObject({
        allowed: true,
        status: ProjectAdmissionDecisionStatus.Allowed,
      });

      const rawRecord = JSON.parse(await readFile(join(
        ledgerRoot,
        "items",
        "synthetic-rejected-worker-1.json",
      ), "utf8"));
      expect(rawRecord).toMatchObject({
        status: "rejected",
        closedAt: expect.any(String),
        archivePath: expect.any(String),
        backup: {
          workspace: workerPath,
          statusPath: expect.any(String),
          patchPath: expect.any(String),
          numstatPath: expect.any(String),
        },
      });
      await expect(readFile(rawRecord.backup.patchPath, "utf8"))
        .resolves.toContain("export const value = 2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout;
}
