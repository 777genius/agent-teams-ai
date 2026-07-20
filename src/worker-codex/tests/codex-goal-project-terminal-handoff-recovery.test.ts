import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  AccessBoundary,
  NetworkAccessMode,
  ProjectAdmissionWorkerRole,
  type ProjectControlBroker,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";

import { materializeCodexGoalHandoffArtifacts } from "../codex-goal-handoff-artifacts";
import {
  createCodexGoalJob,
  type CodexGoalJobManifest,
} from "../codex-goal-jobs";
import {
  terminalHandoffDependencyRecoveryRequested,
  verifyTerminalHandoffRecovery,
} from "../application/project-control/codex-goal-project-terminal-handoff-recovery";
import { localReviewedWorkerOutputDeps } from "../reviewed-worker-output";
import { projectControlStartStoredJobView } from "../codex-goal-mcp-project-control-actions";
import { recordRejectedUncapturedOutput } from "../codex-goal-mcp-project-control-reviewed-rejection";
import { assertCodexGoalProjectJobNotTerminal } from "../application/project-control/codex-goal-consumed-output-ledger-io";
import { git, gitInitRepository } from "./codex-goal-mcp-test-support";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("terminal worker handoff dependency recovery", () => {
  it("requires the complete explicit dependency-recovery intent", () => {
    const request = {
      status: {
        workspaceDirty: true,
        resultExists: true,
        resultStatus: "done",
        recommendedAction: "review_completed",
      },
      forceStart: true,
      dependencyBootstrap: "install",
      confirmDependencyBootstrap: true,
    } as const;
    expect(terminalHandoffDependencyRecoveryRequested(request)).toBe(true);
    for (const invalid of [
      { ...request, status: { ...request.status, workspaceDirty: false } },
      { ...request, reviewedOutputId: "a".repeat(64) },
      { ...request, forceStart: false },
      { ...request, dependencyBootstrap: "preflight" },
      { ...request, confirmDependencyBootstrap: false },
      { ...request, status: { ...request.status, resultExists: false } },
      { ...request, status: { ...request.status, resultStatus: "failed" } },
      {
        ...request,
        status: {
          ...request.status,
          recommendedAction: "inspect_dirty_workspace" as const,
        },
      },
    ]) {
      expect(terminalHandoffDependencyRecoveryRequested(invalid)).toBe(false);
    }
  });

  it("permits only the exact runtime-captured dirty workspace", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "subscription-runtime-terminal-recovery-"),
    );
    roots.push(root);
    const workspacePath = join(root, "workspace");
    const jobRootDir = join(root, "job");
    const jobId = "project-worker";
    await Promise.all([
      mkdir(workspacePath, { recursive: true }),
      mkdir(jobRootDir, { recursive: true }),
    ]);
    await gitInitRepository(workspacePath);
    await writeFile(
      join(workspacePath, "owned.ts"),
      "export const value = 1;\n",
    );
    await git(workspacePath, ["add", "owned.ts"]);
    await git(workspacePath, ["commit", "-m", "test: base"]);
    await writeFile(
      join(workspacePath, "owned.ts"),
      "export const value = 2;\n",
    );

    const handoff = await materializeCodexGoalHandoffArtifacts({
      workerJobId: jobId,
      taskId: jobId,
      workspacePath,
      jobRootDir,
    });
    expect(handoff).not.toBeNull();
    await writeTerminalResult(jobRootDir, jobId, handoff!);
    const producer = {
      jobId,
      taskId: jobId,
      workspacePath,
      jobRootDir,
    } as CodexGoalJobManifest;
    const snapshotter = localReviewedWorkerOutputDeps({
      rootDir: join(root, "reviewed-output"),
    }).snapshotter;

    await expect(
      verifyTerminalHandoffRecovery({
        producer,
        workspacePath,
        snapshotter,
      }),
    ).resolves.toMatchObject({
      patchSha256: handoff!.manifest.artifacts.patch.sha256,
      baseCommit: handoff!.baseCommit,
      changedFiles: ["owned.ts"],
    });

    await writeFile(
      join(workspacePath, "owned.ts"),
      "export const value = 3;\n",
    );
    await expect(
      verifyTerminalHandoffRecovery({
        producer,
        workspacePath,
        snapshotter,
      }),
    ).rejects.toThrow(
      "project_control_terminal_handoff_workspace_changed_after_capture",
    );
  });

  it("pins the pre-bootstrap handoff and rejects reviewed output", async () => {
    const fixture = await recoveryFixture();
    const before = await verifyTerminalHandoffRecovery(fixture.verifyInput);
    await writeFile(
      join(fixture.workspacePath, "owned.ts"),
      "export const value = 3;\n",
    );
    const next = await materializeCodexGoalHandoffArtifacts({
      workerJobId: fixture.jobId,
      taskId: fixture.jobId,
      workspacePath: fixture.workspacePath,
      jobRootDir: fixture.jobRootDir,
    });
    if (!next) throw new Error("expected next handoff");
    await writeTerminalResult(fixture.jobRootDir, fixture.jobId, next);
    await expect(
      verifyTerminalHandoffRecovery({
        ...fixture.verifyInput,
        expected: before,
      }),
    ).rejects.toThrow(
      "project_control_terminal_handoff_changed_during_dependency_bootstrap",
    );

    await writeFile(
      join(fixture.jobRootDir, `${fixture.jobId}.review.json`),
      '{"reviewedAt":"2026-07-14T00:00:00.000Z","decision":"rejected"}\n',
    );
    await expect(
      verifyTerminalHandoffRecovery(fixture.verifyInput),
    ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
  });

  it("permits same-job start only with the exact rejected uncaptured patch", async () => {
    const fixture = await actionFixture();
    const receipt = await writeRejectedUncapturedReview(fixture);
    const verified = await verifyActionFixture(fixture);
    expect(verified).toMatchObject({
      reviewDisposition: "rejected_uncaptured",
      patchSha256: receipt.decision.attemptId?.replace(
        "uncaptured-rejection-",
        "",
      ),
    });

    let startCalled = false;
    const started = await projectControlStartStoredJobView(
      fixture.startArgs,
      {
        ...fixture.deps(async () => {}),
        codexProjectControlBroker: (input) => ({
          startWorker: async () => {
            startCalled = true;
            const recovery =
              input.rejectedUncapturedTerminalHandoffRecovery;
            expect(
              recovery,
            ).toEqual({ patchSha256: verified.patchSha256 });
            if (!recovery) throw new Error("expected rejected recovery");
            await assertCodexGoalProjectJobNotTerminal({
              roots: input.scope.consumedOutputLedgerRoots ?? [],
              projectId: input.scope.projectId,
              controllerJobId: input.controller.jobId,
              jobId: fixture.jobId,
              taskId: fixture.jobId,
              workspacePath: fixture.workspacePath,
              rejectedUncapturedContinuationPatchSha256:
                recovery.patchSha256,
            });
            return { status: "started" };
          },
        }) as unknown as ProjectControlBroker,
      },
    );
    expect(started).toMatchObject({ ok: true, jobId: fixture.jobId });
    expect(startCalled).toBe(true);
  });

  it("rejects archive tamper at recovery and terminal admission", async () => {
    const fixture = await actionFixture();
    const receipt = await writeRejectedUncapturedReview(fixture);
    const verified = await verifyActionFixture(fixture);
    await writeFile(
      receipt.decision.backup.patchPath!,
      `${await readFile(receipt.decision.backup.patchPath!, "utf8")}tampered\n`,
    );
    await expect(
      verifyActionFixture(fixture),
    ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
    await expect(
      assertTerminalAdmission(fixture, verified.patchSha256),
    ).rejects.toThrow(
      "project_control_terminal_job_start_denied:rejected_evidence_mismatch",
    );
  });

  it("rejects an unexpected rejected patch identity at terminal admission", async () => {
    const fixture = await actionFixture();
    await writeRejectedUncapturedReview(fixture);
    await expect(
      assertTerminalAdmission(fixture, "f".repeat(64)),
    ).rejects.toThrow(
      "project_control_terminal_job_start_denied:rejected_evidence_mismatch",
    );
  });

  it.each([
    "malformed",
    "semantic-invalid",
    "invalid-date",
    "unknown-status",
    "missing-status",
    "null-status",
    "empty-status",
    "missing-job-id",
    "wrong-job-id",
    "symlink",
  ])(
    "rejects relevant %s newer ledger evidence",
    async (kind) => {
      const fixture = await actionFixture();
      const receipt = await writeRejectedUncapturedReview(fixture);
      const items = join(fixture.ledgerRoot, "items");
      const path = join(items, `${fixture.jobId}--zz-newer.json`);
      if (kind === "malformed") {
        await writeFile(path, "{not-json\n");
      } else if (kind === "semantic-invalid") {
        await writeFile(path, `${JSON.stringify({
          schemaVersion: 1,
          jobId: fixture.jobId,
          attemptId: "newer-ambiguous",
          status: "rejected",
          note: "Missing backup evidence.",
        })}\n`);
      } else if (kind === "unknown-status") {
        await writeFile(path, `${JSON.stringify({
          jobId: fixture.jobId,
          status: "unknown",
        })}\n`);
      } else if (kind === "invalid-date") {
        const value = JSON.parse(await readFile(receipt.ledgerPath, "utf8"));
        await writeFile(path, `${JSON.stringify({
          ...value,
          attemptId: "newer-invalid-date",
          closedAt: "not-a-date",
        })}\n`);
      } else if (
        kind === "missing-status" ||
        kind === "null-status" ||
        kind === "empty-status"
      ) {
        await writeFile(path, `${JSON.stringify({
          jobId: fixture.jobId,
          ...(kind === "missing-status"
            ? {}
            : { status: kind === "null-status" ? null : "" }),
        })}\n`);
      } else if (kind === "missing-job-id" || kind === "wrong-job-id") {
        await writeFile(path, `${JSON.stringify({
          schemaVersion: 1,
          ...(kind === "wrong-job-id" ? { jobId: "project-other" } : {}),
          status: "rejected",
          closedAt: "2027-01-01T00:00:00.000Z",
        })}\n`);
      } else {
        await symlink("missing-ledger-target", path);
      }
      await expect(
        verifyActionFixture(fixture),
      ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
    },
  );

  it("rejects rejected ledger evidence when its review marker is missing", async () => {
    const fixture = await actionFixture();
    await recordRejectedUncapturedOutput({
      scope: fixture.scope,
      jobId: fixture.jobId,
      jobRootDir: fixture.jobRootDir,
      workspacePath: fixture.workspacePath,
      closedAt: "2026-07-21T00:00:00.000Z",
      reason: "Marker intentionally absent.",
    });
    let bootstrapCalled = false;
    await expect(
      projectControlStartStoredJobView(
        fixture.startArgs,
        fixture.deps(async () => {
          bootstrapCalled = true;
        }),
      ),
    ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
    expect(bootstrapCalled).toBe(false);
  });

  it.each([
    "malformed",
    "unknown-status",
    "missing-status",
    "null-status",
    "empty-status",
    "symlink",
  ])(
    "rejects marker-missing target-prefixed %s debt before bootstrap",
    async (kind) => {
      const fixture = await actionFixture();
      const items = join(fixture.ledgerRoot, "items");
      const path = join(items, `${fixture.jobId}--zz.json`);
      await mkdir(items, { recursive: true });
      if (kind === "malformed") {
        await writeFile(path, "{not-json\n");
      } else if (kind === "unknown-status") {
        await writeFile(path, `${JSON.stringify({
          jobId: fixture.jobId,
          status: "unknown",
        })}\n`);
      } else if (
        kind === "missing-status" ||
        kind === "null-status" ||
        kind === "empty-status"
      ) {
        await writeFile(path, `${JSON.stringify({
          jobId: fixture.jobId,
          ...(kind === "missing-status"
            ? {}
            : { status: kind === "null-status" ? null : "" }),
        })}\n`);
      } else {
        await symlink("missing-ledger-target", path);
      }
      let bootstrapCalled = false;
      await expect(
        projectControlStartStoredJobView(
          fixture.startArgs,
          fixture.deps(async () => {
            bootstrapCalled = true;
          }),
        ),
      ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
      expect(bootstrapCalled).toBe(false);
    },
  );

  it("rejects a configured missing ledger items directory before bootstrap", async () => {
    const fixture = await actionFixture();
    await rm(join(fixture.ledgerRoot, "items"), { recursive: true });
    let bootstrapCalled = false;
    await expect(
      projectControlStartStoredJobView(
        fixture.startArgs,
        fixture.deps(async () => {
          bootstrapCalled = true;
        }),
      ),
    ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
    expect(bootstrapCalled).toBe(false);
  });

  it.each([0, 2])(
    "rejects rejected recovery with %i consumed-output ledger roots",
    async (rootCount) => {
      const fixture = await actionFixture();
      await writeRejectedUncapturedReview(fixture);
      const roots = rootCount === 0
        ? []
        : [fixture.ledgerRoot, join(fixture.registryRootDir, "other-ledger")];
      await expect(
        verifyActionFixture(fixture, roots),
      ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
    },
  );

  it.each(["approved", "rejected"])(
    "rejects captured %s review marker despite uncaptured ledger evidence",
    async (decision) => {
      const fixture = await actionFixture();
      await writeRejectedUncapturedReview(fixture);
      await writeReviewMarker(fixture, {
        reviewedOutput: { decision, reviewedOutputId: "a".repeat(64) },
      });
      await expect(
        verifyActionFixture(fixture),
      ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
    },
  );

  it("holds the project start lock across dependency bootstrap verification", async () => {
    const fixture = await actionFixture();
    await expect(
      projectControlStartStoredJobView(
        fixture.startArgs,
        fixture.deps(async () => {
          await writeFile(
            join(fixture.workspacePath, "owned.ts"),
            "export const value = 3;\n",
          );
          const next = await materializeCodexGoalHandoffArtifacts({
            workerJobId: fixture.jobId,
            taskId: fixture.jobId,
            workspacePath: fixture.workspacePath,
            jobRootDir: fixture.jobRootDir,
          });
          if (!next) throw new Error("expected next handoff");
          await writeTerminalResult(fixture.jobRootDir, fixture.jobId, next);
        }),
      ),
    ).rejects.toThrow(
      "project_control_terminal_handoff_changed_during_dependency_bootstrap",
    );
  });

  it("routes an exact terminal handoff recovery to a scoped alternative account", async () => {
    const fixture = await actionFixture();
    let brokerLaunchAccounts: readonly string[] = [];
    let brokerStartAccounts: readonly string[] = [];
    let brokerWorkerRole:
      Parameters<ProjectControlBroker["startWorker"]>[0]["workerRole"];
    let brokerMaxAccountCycles: number | undefined;
    const started = await projectControlStartStoredJobView(
      {
        ...fixture.startArgs,
        continuationAccounts: ["account-b"],
      },
      {
        ...fixture.deps(async () => {}),
        listAccountStatuses: async () => [{
          name: "account-b",
          authJsonPath: "/auth/account-b/auth.json",
          status: "ready",
          availability: "available",
          schedulerEligible: true,
          recommendedAction: "none",
          warnings: [],
          safeMessage: "ready",
        }],
        codexProjectControlBroker: (input) => {
          brokerLaunchAccounts =
            input.startLaunch?.config.accounts.map((account) => account.name) ??
              [];
          brokerMaxAccountCycles =
            input.startLaunch?.config.maxAccountCycles;
          return {
            startWorker: async (
              request: Parameters<ProjectControlBroker["startWorker"]>[0],
            ) => {
              brokerStartAccounts = request.accounts ?? [];
              brokerWorkerRole = request.workerRole;
              return { status: "started" };
            },
          } as unknown as ProjectControlBroker;
        },
      },
    );

    expect(started).toMatchObject({
      ok: true,
      accountReservation: {
        mode: "shared",
        accountId: "account-b",
      },
    });
    expect(brokerLaunchAccounts).toEqual(["account-b"]);
    expect(brokerStartAccounts).toEqual(["account-b"]);
    expect(brokerWorkerRole).toBe(ProjectAdmissionWorkerRole.Adoption);
    expect(brokerMaxAccountCycles).toBe(1);
  });

  it.each(["approved", "rejected"])(
    "rejects a %s review marker before dependency bootstrap",
    async (decision) => {
      const fixture = await actionFixture();
      await writeFile(
        join(fixture.jobRootDir, `${fixture.jobId}.review.json`),
        `${JSON.stringify({ reviewedAt: new Date().toISOString(), decision })}\n`,
      );
      let bootstrapCalled = false;
      await expect(
        projectControlStartStoredJobView(
          fixture.startArgs,
          fixture.deps(async () => {
            bootstrapCalled = true;
          }),
        ),
      ).rejects.toThrow("project_control_terminal_handoff_already_reviewed");
      expect(bootstrapCalled).toBe(false);
    },
  );
});

async function recoveryFixture() {
  const root = await mkdtemp(
    join(tmpdir(), "subscription-runtime-terminal-recovery-pinned-"),
  );
  roots.push(root);
  const workspacePath = join(root, "workspace");
  const jobRootDir = join(root, "job");
  const jobId = "project-worker";
  await Promise.all([
    mkdir(workspacePath, { recursive: true }),
    mkdir(jobRootDir, { recursive: true }),
  ]);
  await gitInitRepository(workspacePath);
  await writeFile(join(workspacePath, "owned.ts"), "export const value = 1;\n");
  await git(workspacePath, ["add", "owned.ts"]);
  await git(workspacePath, ["commit", "-m", "test: base"]);
  await writeFile(join(workspacePath, "owned.ts"), "export const value = 2;\n");
  const handoff = await materializeCodexGoalHandoffArtifacts({
    workerJobId: jobId,
    taskId: jobId,
    workspacePath,
    jobRootDir,
  });
  if (!handoff) throw new Error("expected handoff");
  await writeTerminalResult(jobRootDir, jobId, handoff);
  const producer = {
    jobId,
    taskId: jobId,
    workspacePath,
    jobRootDir,
  } as CodexGoalJobManifest;
  const snapshotter = localReviewedWorkerOutputDeps({
    rootDir: join(root, "reviewed-output"),
  }).snapshotter;
  return {
    workspacePath,
    jobRootDir,
    jobId,
    verifyInput: { producer, workspacePath, snapshotter },
  };
}

async function writeTerminalResult(
  jobRootDir: string,
  taskId: string,
  handoff: NonNullable<
    Awaited<ReturnType<typeof materializeCodexGoalHandoffArtifacts>>
  >,
): Promise<void> {
  await writeFile(
    join(jobRootDir, `${taskId}.latest-result.json`),
    `${JSON.stringify({
      status: "done",
      changedFiles: handoff.changedPaths,
      evidence: [],
      blockers: [],
      nextAction: "review_completed",
      artifacts: handoff.artifacts,
      details: { baseCommit: handoff.baseCommit },
    })}\n`,
  );
}

async function actionFixture() {
  const root = await mkdtemp(
    join(tmpdir(), "subscription-runtime-terminal-recovery-action-"),
  );
  roots.push(root);
  const registryRootDir = join(root, "registry");
  const worktreeRoot = join(root, "worktrees");
  const workspacePath = join(worktreeRoot, "project-worker");
  const canonicalWorkspacePath = join(root, "canonical");
  const jobRootDir = join(root, "jobs", "project-worker");
  const promptPath = join(jobRootDir, "prompt.md");
  const jobId = "project-worker";
  const ledgerRoot = join(root, "consumed-output-ledger");
  await Promise.all([
    mkdir(workspacePath, { recursive: true }),
    mkdir(canonicalWorkspacePath, { recursive: true }),
    mkdir(jobRootDir, { recursive: true }),
    mkdir(join(ledgerRoot, "items"), { recursive: true }),
  ]);
  await gitInitRepository(workspacePath);
  await gitInitRepository(canonicalWorkspacePath);
  await writeFile(join(workspacePath, "owned.ts"), "export const value = 1;\n");
  await git(workspacePath, ["add", "owned.ts"]);
  await git(workspacePath, ["commit", "-m", "test: base"]);
  await writeFile(join(workspacePath, "owned.ts"), "export const value = 2;\n");
  await writeFile(promptPath, "Run checks only.\n");
  const handoff = await materializeCodexGoalHandoffArtifacts({
    workerJobId: jobId,
    taskId: jobId,
    workspacePath,
    jobRootDir,
  });
  if (!handoff) throw new Error("expected handoff");
  await writeTerminalResult(jobRootDir, jobId, handoff);
  const scope: ProjectAccessScope = {
    projectId: "project",
    workspaceRoots: [canonicalWorkspacePath],
    worktreeRoots: [worktreeRoot],
    registryRoot: registryRootDir,
    jobIdPrefixes: ["project-"],
    tmuxSessionPrefixes: ["project-"],
    allowedAccountIds: ["account-a", "account-b"],
    allowedBranches: ["main"],
    allowedGitRemotes: ["origin"],
    consumedOutputLedgerRoots: [ledgerRoot],
  };
  await createCodexGoalJob({
    registryRootDir,
    manifest: {
      jobId,
      jobRootDir,
      authRootDir: join(root, "auth"),
      workspacePath,
      promptPath,
      taskId: jobId,
      accounts: ["account-a"],
      tmuxSession: jobId,
      accessBoundary: AccessBoundary.ProjectScopedControl,
      projectAccessScope: scope,
      networkAccess: NetworkAccessMode.Restricted,
    },
  });
  const controller = {
    schemaVersion: 1,
    jobId: "project-controller",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    jobRootDir: join(root, "jobs", "project-controller"),
    workspacePath: canonicalWorkspacePath,
    promptPath: join(root, "jobs", "project-controller", "prompt.md"),
    taskId: "project-controller",
    accounts: ["account-a"],
    accessBoundary: AccessBoundary.ProjectScopedControl,
    projectAccessScope: scope,
  } as CodexGoalJobManifest;
  const producer = {
    jobId,
    taskId: jobId,
    workspacePath,
    jobRootDir,
    projectAccessScope: scope,
  } as CodexGoalJobManifest;
  const snapshotter = localReviewedWorkerOutputDeps({
    rootDir: join(root, "reviewed-output"),
  }).snapshotter;
  return {
    registryRootDir,
    workspacePath,
    jobRootDir,
    jobId,
    ledgerRoot,
    scope,
    controller,
    producer,
    snapshotter,
    startArgs: {
      registryRootDir,
      controllerJobId: controller.jobId,
      jobId,
      confirmStart: true,
      forceStart: true,
      dependencyBootstrap: "install" as const,
      confirmDependencyBootstrap: true,
    },
    deps: (duringBootstrap: () => Promise<void>) => ({
      loadProjectControlController: async () => ({
        registryRootDir,
        controller,
        scope,
      }),
      loadJobLaunch: async () => {
        throw new Error("unexpected loadJobLaunch");
      },
      codexProjectControlBroker: () => {
        throw new Error("unexpected broker start");
      },
      dependencyBootstrap: async () => {
        await duringBootstrap();
        return {
          mode: "install" as const,
          workspacePath,
          nodeModulesPath: join(workspacePath, "node_modules"),
          nodeModulesExists: true,
          binaryChecks: [],
          fingerprintInputs: [],
          status: "installed" as const,
          warnings: [],
        };
      },
    }),
  };
}

async function writeRejectedUncapturedReview(
  fixture: Awaited<ReturnType<typeof actionFixture>>,
) {
  const receipt = await recordRejectedUncapturedOutput({
    scope: fixture.scope,
    jobId: fixture.jobId,
    jobRootDir: fixture.jobRootDir,
    workspacePath: fixture.workspacePath,
    closedAt: "2026-07-21T00:00:00.000Z",
    reason: "Rejected for same-job remediation.",
  });
  await writeReviewMarker(fixture, {});
  return receipt;
}

async function writeReviewMarker(
  fixture: Awaited<ReturnType<typeof actionFixture>>,
  overrides: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    join(fixture.jobRootDir, `${fixture.jobId}.review.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      jobId: fixture.jobId,
      taskId: fixture.jobId,
      reviewedAt: "2026-07-21T00:00:00.000Z",
      note: "FORMAL REJECT",
      status: { resultStatus: "done", workspaceDirty: true },
      ...overrides,
    })}\n`,
  );
}

async function assertTerminalAdmission(
  fixture: Awaited<ReturnType<typeof actionFixture>>,
  patchSha256: string,
): Promise<void> {
  await assertCodexGoalProjectJobNotTerminal({
    roots: [fixture.ledgerRoot],
    projectId: fixture.scope.projectId,
    controllerJobId: fixture.controller.jobId,
    jobId: fixture.jobId,
    taskId: fixture.jobId,
    workspacePath: fixture.workspacePath,
    rejectedUncapturedContinuationPatchSha256: patchSha256,
  });
}

async function verifyActionFixture(
  fixture: Awaited<ReturnType<typeof actionFixture>>,
  roots: readonly string[] = [fixture.ledgerRoot],
) {
  return await verifyTerminalHandoffRecovery({
    producer: fixture.producer,
    workspacePath: fixture.workspacePath,
    snapshotter: fixture.snapshotter,
    consumedOutputLedgerRoots: roots,
  });
}
