import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  CheckRunStatus,
  IntegrationErrorReason,
  SecretScanStatus,
  type IntegrationAttempt,
} from "@vioxen/subscription-runtime/worker-core";
import {
  ConfiguredCommitIdentityAdapter,
  captureLocalTerminalOutputBackup,
  LocalConsumedOutputLedgerWriter,
  LocalGitIntegrationAdapter,
  LocalIntegratedOutputLedgerAdapter,
  LocalProjectCheckRunner,
  LocalWorkspaceIntegrationLock,
  SimpleSecretScanner,
} from "../index";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

describe("local project integration adapters", () => {
  it("applies, commits, and pushes a worker commit through git cli", async () => {
    const fixture = await createGitFixture();
    const adapter = new LocalGitIntegrationAdapter();

    await expect(adapter.getStatus({ workspacePath: fixture.workspacePath }))
      .resolves.toEqual({ branch: "main", dirtyFiles: [] });

    await expect(adapter.applyWorkerOutput({
      attempt: {
        targetWorkspacePath: fixture.workspacePath,
        expectedFiles: ["src/memory.ts"],
      },
      workerOutput: {
        workspacePath: fixture.workspacePath,
        commitSha: fixture.workerCommitSha,
      },
    })).resolves.toEqual({ changedFiles: ["src/memory.ts"] });
    await expect(adapter.diffCheck({ workspacePath: fixture.workspacePath }))
      .resolves.toEqual({ ok: true });

    const commit = await adapter.commit({
      workspacePath: fixture.workspacePath,
      message: "fix(memory): integrate worker output",
      files: ["src/memory.ts"],
      identity: {
        name: "Approved Integrator",
        email: "integrator@example.com",
      },
    });
    expect(commit.commitSha).toMatch(/^[a-f0-9]{40}$/);
    await expect(gitOutput(fixture.workspacePath, [
      "show",
      "-s",
      "--format=%an <%ae>",
      commit.commitSha,
    ])).resolves.toBe("Approved Integrator <integrator@example.com>\n");

    await adapter.push({
      workspacePath: fixture.workspacePath,
      remote: "origin",
      branch: "main",
      commitSha: commit.commitSha,
      force: false,
    });
    const pushed = await gitOutput(
      fixture.workspacePath,
      ["ls-remote", "origin", "refs/heads/main"],
    );
    expect(pushed).toContain(commit.commitSha);
  });

  it("applies an immutable conflict resolution and creates an exact two-parent merge", async () => {
    const fixture = await createMergeFixture();
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });
    const attempt = {
      targetWorkspacePath: fixture.workspacePath,
      expectedFiles: ["src/memory.ts"],
      merge: {
        sourceRemote: "origin",
        sourceBranch: "base",
        sourceCommit: fixture.sourceCommit,
        expectedTargetCommit: fixture.targetCommit,
      },
    };
    const workerOutput = {
      workerJobId: "merge-resolution-worker",
      workspacePath: fixture.workspacePath,
      patchPath: fixture.patchPath,
      patchSha256: fixture.patchSha256,
      baseCommit: fixture.targetCommit,
      changedFiles: ["src/memory.ts"],
    };

    await expect(adapter.applyWorkerOutput({ attempt, workerOutput }))
      .resolves.toEqual({ changedFiles: ["src/memory.ts"] });
    const commit = await adapter.commit({
      workspacePath: fixture.workspacePath,
      message: "merge: integrate current base",
      files: ["src/memory.ts"],
      identity: { name: "Integrator", email: "integrator@example.com" },
      expectedParentCommits: [fixture.targetCommit, fixture.sourceCommit],
    });

    expect(commit.parentCommits).toEqual([
      fixture.targetCommit,
      fixture.sourceCommit,
    ]);
    await expect(adapter.commit({
      workspacePath: fixture.workspacePath,
      message: "merge: integrate current base",
      files: ["src/memory.ts"],
      identity: { name: "Integrator", email: "integrator@example.com" },
      expectedParentCommits: [fixture.targetCommit, fixture.sourceCommit],
    })).resolves.toEqual(commit);
    await expect(readFile(
      join(fixture.workspacePath, "src", "memory.ts"),
      "utf8",
    )).resolves.toBe("export const value = 3;\n");
  });

  it("refuses to adopt an existing merge commit with different provenance", async () => {
    const fixture = await createMergeFixture();
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });
    const attempt = {
      targetWorkspacePath: fixture.workspacePath,
      expectedFiles: ["src/memory.ts"],
      merge: {
        sourceRemote: "origin",
        sourceBranch: "base",
        sourceCommit: fixture.sourceCommit,
        expectedTargetCommit: fixture.targetCommit,
      },
    };
    await adapter.applyWorkerOutput({
      attempt,
      workerOutput: {
        workerJobId: "merge-resolution-worker",
        workspacePath: fixture.workspacePath,
        patchPath: fixture.patchPath,
        patchSha256: fixture.patchSha256,
        baseCommit: fixture.targetCommit,
        changedFiles: ["src/memory.ts"],
      },
    });
    await adapter.commit({
      workspacePath: fixture.workspacePath,
      message: "merge: integrate current base",
      files: ["src/memory.ts"],
      identity: { name: "Integrator", email: "integrator@example.com" },
      expectedParentCommits: [fixture.targetCommit, fixture.sourceCommit],
    });

    await expect(adapter.commit({
      workspacePath: fixture.workspacePath,
      message: "merge: different message",
      files: ["src/memory.ts"],
      identity: { name: "Integrator", email: "integrator@example.com" },
      expectedParentCommits: [fixture.targetCommit, fixture.sourceCommit],
    })).rejects.toMatchObject({
      reason: IntegrationErrorReason.MergeCommitRecoveryMismatch,
    });
  });

  it("aborts a merge when the reviewed resolution does not match the conflict set", async () => {
    const fixture = await createMergeFixture();
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });

    await expect(adapter.applyWorkerOutput({
      attempt: {
        targetWorkspacePath: fixture.workspacePath,
        expectedFiles: ["src/memory.ts"],
        merge: {
          sourceRemote: "origin",
          sourceBranch: "base",
          sourceCommit: fixture.sourceCommit,
          expectedTargetCommit: fixture.targetCommit,
        },
      },
      workerOutput: {
        workerJobId: "merge-resolution-worker",
        workspacePath: fixture.workspacePath,
        patchPath: fixture.patchPath,
        patchSha256: fixture.patchSha256,
        baseCommit: fixture.targetCommit,
        changedFiles: ["src/not-the-conflict.ts"],
      },
    })).rejects.toThrow("local_git_integration_merge_conflict_set_mismatch");

    expect((await gitOutput(fixture.workspacePath, ["rev-parse", "HEAD"])).trim())
      .toBe(fixture.targetCommit);
    expect(await gitOutput(fixture.workspacePath, ["status", "--porcelain"]))
      .toBe("");
    await expect(execFileAsync("git", ["rev-parse", "--verify", "MERGE_HEAD"], {
      cwd: fixture.workspacePath,
    })).rejects.toBeDefined();
  });

  it("applies an approved patch artifact from an allowed project root", async () => {
    const fixture = await createGitFixture();
    const patchRoot = join(fixture.rootDir, "worker-jobs");
    await mkdir(patchRoot);
    const patchPath = join(patchRoot, "worker-output.patch");
    const patch = await gitOutput(fixture.workspacePath, [
      "show",
      "--format=",
      fixture.workerCommitSha,
    ]);
    await writeFile(patchPath, patch);

    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [patchRoot],
    });

    await expect(adapter.applyWorkerOutput({
      attempt: {
        targetWorkspacePath: fixture.workspacePath,
        expectedFiles: ["src/memory.ts"],
      },
      workerOutput: {
        workspacePath: fixture.workspacePath,
        patchPath,
      },
    })).resolves.toEqual({ changedFiles: ["src/memory.ts"] });
  });

  it("rejects patch paths outside exact expected files before mutating the target", async () => {
    const fixture = await createGitFixture();
    const patchPath = join(fixture.rootDir, "worker-output.patch");
    await writeFile(patchPath, await gitOutput(fixture.workspacePath, [
      "show",
      "--format=",
      fixture.workerCommitSha,
    ]));
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });

    await expect(adapter.applyWorkerOutput({
      attempt: {
        targetWorkspacePath: fixture.workspacePath,
        expectedFiles: ["src/"],
      },
      workerOutput: {
        workspacePath: fixture.workspacePath,
        patchPath,
      },
    })).rejects.toMatchObject({
      reason: IntegrationErrorReason.PathOutsideExpectedFiles,
      evidence: ["src/memory.ts"],
    });
    expect(await gitOutput(fixture.workspacePath, ["status", "--porcelain"]))
      .toBe("");
    expect(await readFile(join(fixture.workspacePath, "src", "memory.ts"), "utf8"))
      .toBe("export const value = 1;\n");
  });

  it("rejects an attempt-owned patch when its stored SHA-256 no longer matches", async () => {
    const fixture = await createGitFixture();
    const patchPath = join(fixture.rootDir, "snapshot.patch");
    const patch = await gitOutput(fixture.workspacePath, [
      "show",
      "--format=",
      fixture.workerCommitSha,
    ]);
    const patchSha256 = createHash("sha256").update(patch).digest("hex");
    await writeFile(patchPath, `${patch}\nsubstituted\n`);
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });

    await expect(adapter.applyWorkerOutput({
      attempt: {
        targetWorkspacePath: fixture.workspacePath,
        expectedFiles: ["src/memory.ts"],
      },
      workerOutput: {
        workspacePath: fixture.workspacePath,
        patchPath,
        patchSha256,
      },
    })).rejects.toThrow("local_git_integration_patch_hash_mismatch");
    expect(await gitOutput(fixture.workspacePath, ["status", "--porcelain"]))
      .toBe("");
  });

  it("recognizes a fully applied patch only when idempotent recovery is allowed", async () => {
    const fixture = await createGitFixture();
    const patchPath = join(fixture.rootDir, "worker-output.patch");
    await writeFile(patchPath, await gitOutput(fixture.workspacePath, [
      "show",
      "--format=",
      fixture.workerCommitSha,
    ]));
    await git(fixture.workspacePath, ["apply", patchPath]);
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });

    await expect(adapter.applyWorkerOutput({
      attempt: {
        targetWorkspacePath: fixture.workspacePath,
        expectedFiles: ["src/memory.ts"],
      },
      workerOutput: {
        workspacePath: fixture.workspacePath,
        patchPath,
      },
      allowAlreadyApplied: true,
    })).resolves.toEqual({ changedFiles: ["src/memory.ts"] });
    expect(await readFile(join(fixture.workspacePath, "src", "memory.ts"), "utf8"))
      .toBe("export const value = 2;\n");
  });

  it("fails closed when a patch is only partially applied", async () => {
    const fixture = await createGitFixture();
    await git(fixture.workspacePath, ["checkout", "worker"]);
    await writeFile(join(fixture.workspacePath, "src", "extra.ts"), "export const extra = 1;\n");
    await git(fixture.workspacePath, ["add", "src/extra.ts"]);
    await git(fixture.workspacePath, ["commit", "-m", "test: add second worker file"]);
    await git(fixture.workspacePath, ["checkout", "main"]);
    const patchPath = join(fixture.rootDir, "worker-output.patch");
    await writeFile(patchPath, await gitOutput(fixture.workspacePath, [
      "diff",
      "--binary",
      "main..worker",
    ]));
    await git(fixture.workspacePath, [
      "apply",
      "--include=src/memory.ts",
      patchPath,
    ]);
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });

    await expect(adapter.applyWorkerOutput({
      attempt: {
        targetWorkspacePath: fixture.workspacePath,
        expectedFiles: ["src/extra.ts", "src/memory.ts"],
      },
      workerOutput: {
        workspacePath: fixture.workspacePath,
        patchPath,
      },
      allowAlreadyApplied: true,
    })).rejects.toThrow("local_git_integration_patch_not_fully_applied");
    expect(await readFile(join(fixture.workspacePath, "src", "memory.ts"), "utf8"))
      .toBe("export const value = 2;\n");
    await expect(readFile(join(fixture.workspacePath, "src", "extra.ts"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips stale missing patch roots before checking an allowed root", async () => {
    const fixture = await createGitFixture();
    const patchRoot = join(fixture.rootDir, "worker-jobs");
    await mkdir(patchRoot);
    const patchPath = join(patchRoot, "worker-output.patch");
    const patch = await gitOutput(fixture.workspacePath, [
      "show",
      "--format=",
      fixture.workerCommitSha,
    ]);
    await writeFile(patchPath, patch);
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [
        join(fixture.rootDir, "removed-legacy-root"),
        patchRoot,
      ],
    });

    await expect(adapter.applyWorkerOutput({
      attempt: {
        targetWorkspacePath: fixture.workspacePath,
        expectedFiles: ["src/memory.ts"],
      },
      workerOutput: {
        workspacePath: fixture.workspacePath,
        patchPath,
      },
    })).resolves.toEqual({ changedFiles: ["src/memory.ts"] });
  });

  it("accepts a patch only from the exact canonical worker job root", async () => {
    const fixture = await createGitFixture();
    const jobsRoot = join(fixture.rootDir, "worker-jobs");
    const workerJobRoot = join(jobsRoot, "worker-1");
    const siblingJobRoot = join(jobsRoot, "worker-2");
    await mkdir(workerJobRoot, { recursive: true });
    await mkdir(siblingJobRoot, { recursive: true });
    const patch = await gitOutput(fixture.workspacePath, [
      "show",
      "--format=",
      fixture.workerCommitSha,
    ]);
    const approvedPatch = join(workerJobRoot, "worker-output.patch");
    const siblingPatch = join(siblingJobRoot, "worker-output.patch");
    await writeFile(approvedPatch, patch);
    await writeFile(siblingPatch, patch);
    const adapter = new LocalGitIntegrationAdapter({
      workerJobRootParent: jobsRoot,
    });

    await expect(adapter.applyWorkerOutput({
      attempt: {
        targetWorkspacePath: fixture.workspacePath,
        expectedFiles: ["src/memory.ts"],
      },
      workerOutput: {
        workerJobId: "worker-1",
        workspacePath: fixture.workspacePath,
        patchPath: siblingPatch,
      },
    })).rejects.toThrow("local_project_integration_path_outside_root");

    await expect(adapter.applyWorkerOutput({
      attempt: {
        targetWorkspacePath: fixture.workspacePath,
        expectedFiles: ["src/memory.ts"],
      },
      workerOutput: {
        workerJobId: "worker-1",
        workspacePath: fixture.workspacePath,
        patchPath: approvedPatch,
      },
    })).resolves.toEqual({ changedFiles: ["src/memory.ts"] });
  });

  it("uses only repository-local identity when scope identity is absent", async () => {
    const fixture = await createGitFixture();
    const adapter = new ConfiguredCommitIdentityAdapter(undefined);

    await expect(adapter.approvedIdentity({
      projectId: "synthetic-project",
      workspacePath: fixture.workspacePath,
    })).resolves.toEqual({
      name: "Test User",
      email: "test@example.com",
    });
  });

  it("fails closed when repository-local identity is absent", async () => {
    const fixture = await createGitFixture();
    await git(fixture.workspacePath, ["config", "--local", "--unset", "user.name"]);
    await git(fixture.workspacePath, ["config", "--local", "--unset", "user.email"]);
    const adapter = new ConfiguredCommitIdentityAdapter(undefined);

    await expect(adapter.approvedIdentity({
      projectId: "synthetic-project",
      workspacePath: fixture.workspacePath,
    })).rejects.toThrow("project_integration_commit_identity_required");
  });

  it("runs declared checks and redacts unsafe output tails", async () => {
    const fixture = await createGitFixture();
    const runner = new LocalProjectCheckRunner();

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "pass",
        command: [process.execPath, "-e", "process.stdout.write('ok')"],
      },
    })).resolves.toMatchObject({
      checkId: "pass",
      status: CheckRunStatus.Passed,
      exitCode: 0,
      safeOutputTail: "ok\n",
    });

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "redact",
        command: [
          process.execPath,
          "-e",
          "console.error('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz'); process.exit(1)",
        ],
      },
    })).resolves.toMatchObject({
      checkId: "redact",
      status: CheckRunStatus.Failed,
      exitCode: 1,
      safeOutputTail: "\nOPENAI_API_KEY=<redacted>\n",
    });
  });

  it("prepares evidence before push and finalizes an idempotent terminal ledger", async () => {
    const fixture = await createGitFixture();
    await writeFile(
      join(fixture.workspacePath, "src", "memory.ts"),
      "export const value = 3;\n",
    );
    const ledgerRoot = join(fixture.rootDir, "ledger");
    const adapter = new LocalIntegratedOutputLedgerAdapter({
      ledgerRoots: [ledgerRoot],
      archiveRoot: join(fixture.rootDir, "archives"),
    });
    const attempt = {
      attemptId: "attempt-1",
      targetWorkspacePath: fixture.workspacePath,
      workerOutput: {
        workerJobId: "worker-1",
        workspacePath: fixture.workspacePath,
        changedFiles: ["src/memory.ts"],
      },
    } as unknown as IntegrationAttempt;
    const preparation = await adapter.prepare({
      attempt,
      commitSha: fixture.workerCommitSha,
    });
    await expect(readFile(preparation.patchPath, "utf8"))
      .resolves.toContain("export const value = 2");

    const first = await adapter.finalize({
      preparation,
      pushedAt: "2026-07-12T00:00:00.000Z",
    });
    const replay = await adapter.finalize({
      preparation,
      pushedAt: "2026-07-12T00:00:00.000Z",
    });
    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
  });

  it("rejects conflicting terminal decisions for the same worker", async () => {
    const fixture = await createGitFixture();
    const writer = new LocalConsumedOutputLedgerWriter();
    const ledgerRoot = join(fixture.rootDir, "ledger");
    const base = {
      schemaVersion: 1 as const,
      jobId: "worker-1",
      attemptId: "attempt-1",
      status: "integrated" as const,
      closedAt: "2026-07-12T00:00:00.000Z",
      commitSha: "abc1234",
      archivePath: "/archive/one",
      note: "approved integration",
      backup: {
        workspace: fixture.workspacePath,
        statusPath: "/archive/one/status",
        patchPath: "/archive/one/patch",
      },
    };
    await writer.record({ ledgerRoot, decision: base });
    await expect(writer.assertCanRecord({
      ledgerRoot,
      decision: { ...base, archivePath: "/archive/two" },
    })).rejects.toThrow("consumed_output_ledger_terminal_conflict");
    await expect(writer.record({
      ledgerRoot,
      decision: { ...base, archivePath: "/archive/two" },
    })).rejects.toThrow("consumed_output_ledger_terminal_conflict");
    await expect(writer.record({
      ledgerRoot,
      decision: { ...base, note: "different approval evidence" },
    })).rejects.toThrow("consumed_output_ledger_terminal_conflict");
    await expect(writer.record({
      ledgerRoot,
      decision: { ...base, closedAt: "2026-07-12T00:01:00.000Z" },
    })).rejects.toThrow("consumed_output_ledger_terminal_conflict");
    await expect(writer.record({
      ledgerRoot,
      decision: {
        ...base,
        preexistingWorkspacePatch: {
          path: "/archive/one/preexisting.patch",
          sha256: "a".repeat(64),
        },
      },
    })).rejects.toThrow("consumed_output_ledger_terminal_conflict");
  });

  it("preserves invalid UTF-8 patch bytes and rejects byte-distinct replay", async () => {
    const fixture = await createGitFixture();
    const archiveRoot = join(fixture.rootDir, "archives");
    const sourcePatchPath = join(fixture.rootDir, "source.patch");
    const firstBytes = Buffer.from([0x64, 0x69, 0x66, 0x66, 0x0a, 0x80]);
    const secondBytes = Buffer.from([0x64, 0x69, 0x66, 0x66, 0x0a, 0x81]);
    await writeFile(sourcePatchPath, firstBytes);

    const captured = await captureLocalTerminalOutputBackup({
      archiveRoot,
      archiveName: "binary-patch",
      workspacePath: fixture.workspacePath,
      changedFiles: [],
      sourcePatchPath,
    });
    await expect(readFile(captured.patchPath)).resolves.toEqual(firstBytes);

    await writeFile(sourcePatchPath, secondBytes);
    await expect(captureLocalTerminalOutputBackup({
      archiveRoot,
      archiveName: "binary-patch",
      workspacePath: fixture.workspacePath,
      changedFiles: [],
      sourcePatchPath,
    })).rejects.toThrow("integrated_output_ledger_preparation_conflict");
  });

  it("preserves a rejected attempt when a later attempt integrates the same worker", async () => {
    const fixture = await createGitFixture();
    const writer = new LocalConsumedOutputLedgerWriter();
    const ledgerRoot = join(fixture.rootDir, "ledger");
    const backup = {
      workspace: fixture.workspacePath,
      statusPath: "/archive/status",
      patchPath: "/archive/patch",
    };
    await writer.record({
      ledgerRoot,
      decision: {
        schemaVersion: 1,
        jobId: "worker-1",
        attemptId: "rejected-attempt",
        status: "rejected",
        closedAt: "2026-07-12T00:00:00.000Z",
        archivePath: "/archive/rejected",
        note: "rejected metadata-only attempt",
        backup,
      },
    });
    const integrated = {
      schemaVersion: 1 as const,
      jobId: "worker-1",
      attemptId: "integrated-attempt",
      status: "integrated" as const,
      closedAt: "2026-07-12T01:00:00.000Z",
      commitSha: "abc123",
      archivePath: "/archive/integrated",
      note: "integrated reviewed output",
      backup,
    };

    await expect(writer.assertCanRecord({ ledgerRoot, decision: integrated }))
      .resolves.toBeUndefined();
    await writer.record({ ledgerRoot, decision: integrated });

    const integratedRecord = JSON.parse(await readFile(
      join(ledgerRoot, "items", "worker-1--integrated-attempt.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(integratedRecord).toMatchObject({
      status: "integrated",
      attemptId: "integrated-attempt",
      commitSha: "abc123",
    });
    await expect(readFile(
      join(ledgerRoot, "items", "worker-1--rejected-attempt.json"),
      "utf8",
    )).resolves.toContain('"status": "rejected"');
  });

  it("runs pnpm checks through corepack when pnpm is not directly installed", async () => {
    const fixture = await createGitFixture();
    const binDir = join(fixture.rootDir, "bin");
    await mkdir(binDir);
    const corepackPath = join(binDir, "corepack");
    await writeFile(
      corepackPath,
      "#!/bin/sh\nprintf '%s' \"$*\"\n",
      "utf8",
    );
    await chmod(corepackPath, 0o755);
    const runner = new LocalProjectCheckRunner({
      env: { PATH: binDir },
    });

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "pnpm-check",
        command: ["pnpm", "exec", "vitest", "run", "unit.test.ts"],
      },
    })).resolves.toMatchObject({
      checkId: "pnpm-check",
      status: CheckRunStatus.Passed,
      exitCode: 0,
      safeOutputTail: "pnpm exec vitest run unit.test.ts\n",
    });
  });

  it("fails checks whose cwd escapes the workspace", async () => {
    const fixture = await createGitFixture();
    const runner = new LocalProjectCheckRunner();

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "outside",
        command: [process.execPath, "-e", "process.exit(0)"],
        cwd: "..",
      },
    })).resolves.toMatchObject({
      checkId: "outside",
      status: CheckRunStatus.Failed,
      safeOutputTail: "check_cwd_outside_workspace",
    });
  });

  it("detects secret-like file contents without printing the secret", async () => {
    const fixture = await createGitFixture();
    await writeFile(
      join(fixture.workspacePath, "src", "secret.ts"),
      "export const token = 'sk-abcdefghijklmnopqrstuvwxyz';\n",
      "utf8",
    );
    const scanner = new SimpleSecretScanner();

    await expect(scanner.scanFiles({
      workspacePath: fixture.workspacePath,
      files: ["src/secret.ts"],
    })).resolves.toEqual({
      status: SecretScanStatus.Failed,
      safeMessage: "secret_like_content:src/secret.ts",
    });
  });

  it("uses a real workspace lock store for integration locks", async () => {
    const fixture = await createGitFixture();
    const lock = new LocalWorkspaceIntegrationLock({
      rootDir: join(fixture.rootDir, "locks"),
    });
    const first = await lock.acquire({
      workspacePath: fixture.workspacePath,
      owner: "attempt-1",
    });

    await expect(lock.acquire({
      workspacePath: fixture.workspacePath,
      owner: "attempt-2",
    })).rejects.toThrow("Workspace is already locked");

    await lock.release(first);
    await expect(lock.acquire({
      workspacePath: fixture.workspacePath,
      owner: "attempt-2",
    })).resolves.toMatchObject({
      owner: "attempt-2",
    });
  });
});

async function createGitFixture(): Promise<{
  readonly rootDir: string;
  readonly workspacePath: string;
  readonly workerCommitSha: string;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "project-integration-adapters-"));
  tempRoots.push(rootDir);
  const workspacePath = join(rootDir, "workspace");
  const remotePath = join(rootDir, "remote.git");
  await mkdir(workspacePath);
  try {
    await git(workspacePath, ["init"]);
    await git(workspacePath, ["checkout", "-b", "main"]);
    await git(workspacePath, ["config", "user.email", "test@example.com"]);
    await git(workspacePath, ["config", "user.name", "Test User"]);
    await mkdir(join(workspacePath, "src"));
    await writeFile(join(workspacePath, "src", "memory.ts"), "export const value = 1;\n");
    await git(workspacePath, ["add", "."]);
    await git(workspacePath, ["commit", "-m", "chore: initial"]);
    await execFileAsync("git", ["init", "--bare", remotePath]);
    await git(workspacePath, ["remote", "add", "origin", remotePath]);
    await git(workspacePath, ["checkout", "-b", "worker"]);
    await writeFile(join(workspacePath, "src", "memory.ts"), "export const value = 2;\n");
    await git(workspacePath, ["add", "."]);
    await git(workspacePath, ["commit", "-m", "fix: worker output"]);
    const workerCommitSha = (await gitOutput(workspacePath, ["rev-parse", "HEAD"])).trim();
    await git(workspacePath, ["checkout", "main"]);
    return { rootDir, workspacePath, workerCommitSha };
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }
}

async function createMergeFixture(): Promise<{
  readonly rootDir: string;
  readonly workspacePath: string;
  readonly sourceCommit: string;
  readonly targetCommit: string;
  readonly patchPath: string;
  readonly patchSha256: string;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "project-integration-merge-"));
  tempRoots.push(rootDir);
  const workspacePath = join(rootDir, "workspace");
  const remotePath = join(rootDir, "remote.git");
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await git(workspacePath, ["init", "-b", "main"]);
  await git(workspacePath, ["config", "user.email", "test@example.com"]);
  await git(workspacePath, ["config", "user.name", "Test User"]);
  await writeFile(
    join(workspacePath, "src", "memory.ts"),
    "export const value = 1;\n",
  );
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "chore: initial"]);
  await execFileAsync("git", ["init", "--bare", remotePath]);
  await git(workspacePath, ["remote", "add", "origin", remotePath]);
  await git(workspacePath, ["checkout", "-b", "base"]);
  await writeFile(
    join(workspacePath, "src", "memory.ts"),
    "export const value = 2;\n",
  );
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "feat: update base"]);
  const sourceCommit = (await gitOutput(
    workspacePath,
    ["rev-parse", "HEAD"],
  )).trim();
  await git(workspacePath, ["push", "origin", "base"]);
  await git(workspacePath, ["checkout", "main"]);
  await writeFile(
    join(workspacePath, "src", "memory.ts"),
    "export const value = 4;\n",
  );
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "feat: update target"]);
  const targetCommit = (await gitOutput(
    workspacePath,
    ["rev-parse", "HEAD"],
  )).trim();
  await git(workspacePath, ["push", "origin", "main"]);
  await writeFile(
    join(workspacePath, "src", "memory.ts"),
    "export const value = 3;\n",
  );
  const patch = await gitOutput(workspacePath, ["diff", "--binary"]);
  const patchPath = join(rootDir, "reviewed-resolution.patch");
  await writeFile(patchPath, patch);
  const patchSha256 = createHash("sha256").update(patch).digest("hex");
  await git(workspacePath, ["checkout", "--", "src/memory.ts"]);
  return {
    rootDir,
    workspacePath,
    sourceCommit,
    targetCommit,
    patchPath,
    patchSha256,
  };
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd });
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout;
}
