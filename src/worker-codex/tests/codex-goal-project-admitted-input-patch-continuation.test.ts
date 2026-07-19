import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  AccessBoundary,
  InMemoryAttemptJournal,
  NetworkAccessMode,
  type ProjectControlBroker,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";

import type {
  CodexGoalJobManifest,
  CodexGoalJobManifestInput,
} from "../codex-goal-jobs";
import { codexGoalJobManifestPath, readCodexGoalJob } from "../codex-goal-jobs";
import type { CodexGoalLaunchInput } from "../codex-goal-ops";
import {
  projectControlStartStoredJobView,
  type CodexGoalMcpProjectControlActionsDeps,
} from "../codex-goal-mcp-project-control-actions";
import { isAdmittedInputPatchCapacityContinuation } from "../application/project-control/codex-goal-project-admitted-input-patch-continuation";
import { isCleanPreStartAdmissionCapacityContinuation } from "../application/project-control/codex-goal-project-clean-capacity-continuation";
import {
  codexGoalWorkerControlService,
  codexGoalWorkerControlTarget,
} from "../application/codex-goal-worker-control";
import {
  assertProjectPreStartAdmissionLaunchBinding,
  planProjectPreStartAdmission,
  prepareProjectPreStartAdmission,
} from "../application/project-control/codex-goal-project-pre-start-admission";
import { authorizeProjectPreStartAdmissionLaunch } from "../application/project-control/codex-goal-project-pre-start-launch-authorization";
import { materializeCodexGoalHandoffArtifacts } from "../codex-goal-handoff-artifacts";
import { codexGoalProgressPath } from "../codex-goal-runner";
import {
  cleanupProjectPreStartAdmissionFixtures,
  createBuiltinFixture,
  withWorkKey,
} from "./codex-goal-project-pre-start-admission-fixture";

afterEach(async () => {
  await cleanupProjectPreStartAdmissionFixtures();
});

describe("admitted input-patch capacity continuation", () => {
  it("recognizes only an evidenced dirty capacity pause", () => {
    const status = {
      workspaceDirty: true,
      recommendedAction: "continue_after_capacity",
      resultStatus: "blocked",
      resultReason: "account_unavailable",
    } as const;
    expect(isAdmittedInputPatchCapacityContinuation(status)).toBe(true);
    expect(
      isAdmittedInputPatchCapacityContinuation({
        ...status,
        workspaceDirty: false,
      }),
    ).toBe(false);
    expect(
      isAdmittedInputPatchCapacityContinuation({
        ...status,
        recommendedAction: "inspect_dirty_failure",
      }),
    ).toBe(false);
    expect(
      isAdmittedInputPatchCapacityContinuation({
        ...status,
        resultReason: "provider_failure",
      }),
    ).toBe(false);
  });

  it("resumes the same admitted patch without reviewed output and rejects drift", async () => {
    const fixture = await createBuiltinFixture();
    const registryRootDir = join(fixture.root, "registry");
    const canonicalWorkspacePath = join(fixture.root, "canonical");
    const worktreeRoot = join(fixture.root, "worktrees");
    const workspacePath = join(worktreeRoot, fixture.manifest.jobId);
    await mkdir(canonicalWorkspacePath, { recursive: true });
    execFileSync("git", ["init", "--quiet"], {
      cwd: canonicalWorkspacePath,
    });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: canonicalWorkspacePath,
    });
    execFileSync("git", ["config", "user.name", "Test"], {
      cwd: canonicalWorkspacePath,
    });
    await writeFile(join(canonicalWorkspacePath, "README.md"), "canonical\n");
    execFileSync("git", ["add", "."], { cwd: canonicalWorkspacePath });
    execFileSync("git", ["commit", "--quiet", "-m", "test: canonical"], {
      cwd: canonicalWorkspacePath,
    });

    await mkdir(worktreeRoot, { recursive: true });
    execFileSync("git", [
      "clone",
      "--quiet",
      fixture.workspacePath,
      workspacePath,
    ]);
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: workspacePath,
    });
    execFileSync("git", ["config", "user.name", "Test"], {
      cwd: workspacePath,
    });
    await mkdir(join(workspacePath, "src"), { recursive: true });
    await writeFile(
      join(workspacePath, "src", "example.ts"),
      "export const value = 1;\n",
    );
    execFileSync("git", ["add", "src/example.ts"], { cwd: workspacePath });
    const stagedPatch = execFileSync(
      "git",
      ["diff", "--cached", "--binary", "--no-ext-diff"],
      { cwd: workspacePath },
    );
    const patchSha256 = sha256(stagedPatch);

    const scope: ProjectAccessScope = {
      projectId: "project",
      workspaceRoots: [canonicalWorkspacePath],
      worktreeRoots: [worktreeRoot],
      registryRoot: registryRootDir,
      jobIdPrefixes: ["project-"],
      tmuxSessionPrefixes: ["project-"],
      allowedAccountIds: ["account-c", "account-g"],
      allowedBranches: ["main"],
      allowedGitRemotes: ["origin"],
      preStartAdmission: { required: true, mode: "serial-builtin" },
    };
    const manifestInput: CodexGoalJobManifestInput = {
      jobId: fixture.manifest.jobId,
      jobRootDir: fixture.manifest.jobRootDir,
      workspacePath,
      promptPath: fixture.manifest.promptPath,
      taskId: fixture.manifest.taskId,
      accounts: ["account-c", "account-g"],
      authRootDir: join(fixture.root, "auth"),
      tmuxSession: fixture.manifest.jobId,
      accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
      networkAccess: NetworkAccessMode.Restricted,
      tags: ["worker-role-producer"],
    };
    const contract = withWorkKey({
      ...fixture.contract,
      workspaceRoot: workspacePath,
      phaseStartSha: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: workspacePath,
        encoding: "utf8",
      }).trim(),
      canonicalSha: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: workspacePath,
        encoding: "utf8",
      }).trim(),
      baseSha: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: workspacePath,
        encoding: "utf8",
      }).trim(),
      inputPatchHash: patchSha256,
      reviewKind: "remediation",
      ownedPaths: ["src/example.ts"],
      executionPolicy: {
        mode: "sandbox-only",
        sandboxRoot: workspacePath,
        forbiddenRealProjects: [join(fixture.root, "forbidden-project")],
      },
    });
    const state = {
      ...fixture.state,
      records: fixture.state.records.map((record) => ({
        ...record,
        ...Object.fromEntries(
          (
            [
              "workKey",
              "baseSha",
              "phaseStartSha",
              "inputPatchHash",
              "reviewKind",
            ] as const
          ).map((field) => [field, contract[field]]),
        ),
      })),
    };
    const plan = planProjectPreStartAdmission({
      value: { mode: "serial-builtin", contract, state },
      confirmed: true,
      scope,
      manifest: manifestInput,
    });
    if (!plan) throw new Error("expected admission plan");
    const manifestDefinition: CodexGoalJobManifest = {
      ...manifestInput,
      schemaVersion: 1,
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
      projectPreStartAdmission: plan.descriptor,
    };
    const manifestPath = codexGoalJobManifestPath({
      registryRootDir,
      jobId: manifestDefinition.jobId,
    });
    await mkdir(join(registryRootDir, manifestDefinition.jobId), {
      recursive: true,
    });
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifestDefinition, null, 2)}\n`,
    );
    const manifest = await readCodexGoalJob({
      registryRootDir,
      jobId: manifestDefinition.jobId,
    });
    await prepareProjectPreStartAdmission({
      plan,
      manifest,
      scope,
      verifiedInputPatchArtifactSha256: patchSha256,
      verifiedInputPatchStagedSha256: patchSha256,
    });
    await authorizeProjectPreStartAdmissionLaunch({ manifest, scope });
    await writeFile(
      join(manifest.jobRootDir, `${manifest.taskId}.latest-result.json`),
      `${JSON.stringify({
        status: "blocked",
        reason: "account_unavailable",
        changedFiles: [],
        evidence: ["safe_execution_status:waiting_capacity"],
        blockers: ["account_unavailable"],
        nextAction: "wait",
      })}\n`,
    );
    const journal = new InMemoryAttemptJournal();
    await recordUnavailableAttempt(
      journal,
      manifest.taskId,
      await realpath(workspacePath),
    );

    const controller = {
      schemaVersion: 1,
      jobId: "project-controller",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
      jobRootDir: join(fixture.root, "jobs", "project-controller"),
      workspacePath: canonicalWorkspacePath,
      promptPath: join(fixture.root, "jobs", "project-controller", "prompt.md"),
      taskId: "project-controller",
      accounts: ["account-a"],
      accessBoundary: AccessBoundary.ProjectScopedControl,
      projectAccessScope: scope,
    } as CodexGoalJobManifest;
    let bootstrapCalls = 0;
    const deps = {
      loadProjectControlController: async () => ({
        registryRootDir,
        controller,
        scope,
      }),
      loadJobLaunch: async () => {
        throw new Error("unexpected_load_job_launch");
      },
      codexProjectControlBroker: () => {
        throw new Error("unexpected_broker_start");
      },
      dependencyBootstrap: async () => {
        bootstrapCalls += 1;
        throw new Error("reached_dependency_bootstrap");
      },
    };
    const args = {
      registryRootDir,
      controllerJobId: controller.jobId,
      jobId: manifest.jobId,
      confirmStart: true,
    };
    await expect(projectControlStartStoredJobView(args, deps)).rejects.toThrow(
      "reached_dependency_bootstrap",
    );
    expect(bootstrapCalls).toBe(1);

    let reservedLaunch: CodexGoalLaunchInput | undefined;
    const startAdmissionWorkspaceModes: Array<string | undefined> = [];
    const continuationDeps: CodexGoalMcpProjectControlActionsDeps = {
      ...deps,
      safeExecutionJournal: journal,
      dependencyBootstrap: async () => ({
        mode: "install" as const,
        workspacePath,
        nodeModulesPath: join(workspacePath, "node_modules"),
        nodeModulesExists: true,
        binaryChecks: [],
        fingerprintInputs: [],
        status: "installed" as const,
        warnings: [],
      }),
      codexProjectControlBroker: (input) => {
        reservedLaunch = input.startLaunch;
        startAdmissionWorkspaceModes.push(input.startAdmissionWorkspaceMode);
        return {
          startWorker: async () => ({ status: "started" }),
        } as unknown as ProjectControlBroker;
      },
    };
    const started = await projectControlStartStoredJobView(
      args,
      continuationDeps,
    );
    expect(started).toMatchObject({
      ok: true,
      accountReservation: { accountId: "account-g" },
    });
    expect(reservedLaunch?.config.accounts).toEqual([{ name: "account-g" }]);
    expect(reservedLaunch?.config.maxAccountCycles).toBe(2);
    expect(
      sha256(
        execFileSync("git", ["diff", "--cached", "--binary", "--no-ext-diff"], {
          cwd: workspacePath,
        }),
      ),
    ).toBe(patchSha256);

    if (!reservedLaunch) throw new Error("expected reserved launch");
    await writeFile(
      join(workspacePath, "src", "example.ts"),
      "export const value = 2;\n",
    );
    const signal = await codexGoalWorkerControlService(
      reservedLaunch,
    ).enqueueSignal({
      target: codexGoalWorkerControlTarget({
        manifest,
        launch: reservedLaunch,
      }),
      intent: "guidance",
      deliveryMode: "interrupt_then_continue",
      body: "Continue the exact admitted task.",
      createdBy: "orchestrator",
      priority: "high",
      signalId: "runtime-interrupt-signal-1",
    });
    const interruptedHandoff = await materializeCodexGoalHandoffArtifacts({
      workerJobId: manifest.jobId,
      taskId: manifest.taskId,
      workspacePath,
      jobRootDir: manifest.jobRootDir,
    });
    if (!interruptedHandoff) throw new Error("expected interrupted handoff");
    const interruptedResultPath = join(
      manifest.jobRootDir,
      `${manifest.taskId}.latest-result.json`,
    );
    const interruptedResult = {
      schemaVersion: 1,
      taskId: manifest.taskId,
      status: "partial",
      reason: "runtime_interrupted",
      updatedAt: new Date().toISOString(),
      changedFiles: ["src/example.ts"],
      evidence: ["safe_execution_status:partial"],
      blockers: ["runtime_interrupted"],
      nextAction: "preserve_patch",
      details: {
        runtimeControl: "interrupt_then_continue",
        signalId: signal.signalId,
        baseCommit: interruptedHandoff.baseCommit,
      },
      artifacts: interruptedHandoff.artifacts,
    };
    await writeFile(
      interruptedResultPath,
      `${JSON.stringify(interruptedResult)}\n`,
    );
    await expect(
      projectControlStartStoredJobView(args, continuationDeps),
    ).resolves.toMatchObject({
      ok: false,
      reason: "status_requires_review",
      requiredOverride: "forceStart",
    });
    await expect(
      projectControlStartStoredJobView(
        { ...args, forceStart: true },
        continuationDeps,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(startAdmissionWorkspaceModes.at(-1)).toBe(
      "admitted_input_patch_runtime_continuation",
    );

    await writeFile(
      interruptedResultPath,
      `${JSON.stringify({ ...interruptedResult, status: "done" })}\n`,
    );
    await expect(
      assertProjectPreStartAdmissionLaunchBinding({
        manifest,
        scope,
        workspaceMode: "admitted_input_patch_runtime_continuation",
      }),
    ).rejects.toThrow("project_control_verifier_handoff_result_invalid");

    await rm(interruptedResultPath);
    await expect(
      assertProjectPreStartAdmissionLaunchBinding({
        manifest,
        scope,
        workspaceMode: "admitted_input_patch_runtime_continuation",
      }),
    ).rejects.toThrow(
      "project_control_runtime_interruption_handoff_result_required",
    );
    await writeFile(
      interruptedResultPath,
      `${JSON.stringify(interruptedResult)}\n`,
    );

    await writeFile(
      join(workspacePath, "src", "example.ts"),
      "export const value = 3;\n",
    );
    await expect(
      projectControlStartStoredJobView(
        { ...args, forceStart: true },
        continuationDeps,
      ),
    ).rejects.toThrow("project_control_pre_start_launch_binding_mismatch");
    expect(bootstrapCalls).toBe(1);
    expect(await readFile(plan.descriptor.receiptPath, "utf8")).toContain(
      '"status": "launch_authorized"',
    );
  });
});

describe("clean pre-start capacity continuation", () => {
  it("recognizes only an unchanged terminal account-capacity pause", () => {
    const status = {
      workspaceDirty: false,
      recommendedAction: "continue_after_capacity",
      resultStatus: "blocked",
      resultReason: "account_unavailable",
      progressResultStatus: "waiting_capacity",
      progressResultReason: "account_unavailable",
    } as const;
    expect(isCleanPreStartAdmissionCapacityContinuation(status)).toBe(true);
    expect(
      isCleanPreStartAdmissionCapacityContinuation({
        ...status,
        resultReason: "quota_limited",
        progressResultReason: "quota_limited",
      }),
    ).toBe(true);
    expect(
      isCleanPreStartAdmissionCapacityContinuation({
        ...status,
        workspaceDirty: true,
      }),
    ).toBe(false);
    expect(
      isCleanPreStartAdmissionCapacityContinuation({
        ...status,
        resultReason: "quota_limited",
        progressResultReason: "account_unavailable",
      }),
    ).toBe(false);
    expect(
      isCleanPreStartAdmissionCapacityContinuation({
        ...status,
        progressResultStatus: "blocked",
      }),
    ).toBe(false);
  });

  it("continues the same clean admitted job on the next journaled account", async () => {
    const fixture = await createBuiltinFixture();
    const registryRootDir = join(fixture.root, "registry");
    const canonicalWorkspacePath = join(fixture.root, "canonical");
    await mkdir(canonicalWorkspacePath, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: canonicalWorkspacePath });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: canonicalWorkspacePath,
    });
    execFileSync("git", ["config", "user.name", "Test"], {
      cwd: canonicalWorkspacePath,
    });
    await writeFile(join(canonicalWorkspacePath, "README.md"), "canonical\n");
    execFileSync("git", ["add", "."], { cwd: canonicalWorkspacePath });
    execFileSync("git", ["commit", "--quiet", "-m", "test: canonical"], {
      cwd: canonicalWorkspacePath,
    });

    const scope: ProjectAccessScope = {
      ...fixture.scope,
      workspaceRoots: [canonicalWorkspacePath],
      worktreeRoots: [fixture.root],
      registryRoot: registryRootDir,
      jobIdPrefixes: ["project-"],
      tmuxSessionPrefixes: ["project-"],
      allowedAccountIds: ["account-c", "account-g"],
      allowedBranches: ["main"],
      allowedGitRemotes: ["origin"],
    };
    const manifestInput: CodexGoalJobManifestInput = {
      ...fixture.manifest,
      accounts: ["account-c", "account-g"],
      authRootDir: join(fixture.root, "auth"),
      tmuxSession: fixture.manifest.jobId,
    };
    const plan = planProjectPreStartAdmission({
      value: {
        mode: "serial-builtin",
        contract: fixture.contract,
        state: fixture.state,
      },
      confirmed: true,
      scope,
      manifest: manifestInput,
    });
    if (!plan) throw new Error("expected admission plan");
    const manifestDefinition: CodexGoalJobManifest = {
      ...manifestInput,
      schemaVersion: 1,
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
      projectPreStartAdmission: plan.descriptor,
    };
    await mkdir(join(registryRootDir, manifestDefinition.jobId), {
      recursive: true,
    });
    await writeFile(
      codexGoalJobManifestPath({
        registryRootDir,
        jobId: manifestDefinition.jobId,
      }),
      `${JSON.stringify(manifestDefinition, null, 2)}\n`,
    );
    const manifest = await readCodexGoalJob({
      registryRootDir,
      jobId: manifestDefinition.jobId,
    });
    await prepareProjectPreStartAdmission({ plan, manifest, scope });
    await authorizeProjectPreStartAdmissionLaunch({ manifest, scope });

    const resultPath = join(
      manifest.jobRootDir,
      `${manifest.taskId}.latest-result.json`,
    );
    const progressPath = codexGoalProgressPath({
      taskId: manifest.taskId,
      jobRootDir: manifest.jobRootDir,
    });
    const writeCapacityResult = async () => {
      await writeFile(
        resultPath,
        `${JSON.stringify({
          status: "blocked",
          reason: "account_unavailable",
          changedFiles: [],
          evidence: ["safe_execution_status:waiting_capacity"],
          blockers: ["account_unavailable"],
          nextAction: "wait",
        })}\n`,
      );
      await writeFile(
        progressPath,
        `${JSON.stringify({
          schemaVersion: 1,
          taskId: manifest.taskId,
          status: "blocked",
          resultStatus: "waiting_capacity",
          reason: "account_unavailable",
          updatedAt: new Date().toISOString(),
        })}\n`,
      );
    };
    await writeCapacityResult();

    const journal = new InMemoryAttemptJournal();
    await recordUnavailableAttempt(
      journal,
      manifest.taskId,
      await realpath(manifest.workspacePath),
      false,
    );
    const controller = {
      schemaVersion: 1,
      jobId: "project-controller",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
      jobRootDir: join(fixture.root, "jobs", "project-controller"),
      workspacePath: canonicalWorkspacePath,
      promptPath: join(fixture.root, "jobs", "project-controller", "prompt.md"),
      taskId: "project-controller",
      accounts: ["account-a"],
      accessBoundary: AccessBoundary.ProjectScopedControl,
      projectAccessScope: scope,
    } as CodexGoalJobManifest;
    let bootstrapCalls = 0;
    let capacitySupervisorReapCalls = 0;
    let reservedLaunch: CodexGoalLaunchInput | undefined;
    let startAdmissionWorkspaceMode: string | undefined;
    const deps: CodexGoalMcpProjectControlActionsDeps = {
      loadProjectControlController: async () => ({
        registryRootDir,
        controller,
        scope,
      }),
      loadJobLaunch: async () => {
        throw new Error("unexpected_load_job_launch");
      },
      safeExecutionJournal: journal,
      dependencyBootstrap: async () => {
        bootstrapCalls += 1;
        return {
          mode: "install" as const,
          workspacePath: manifest.workspacePath,
          nodeModulesPath: join(manifest.workspacePath, "node_modules"),
          nodeModulesExists: true,
          binaryChecks: [],
          fingerprintInputs: [],
          status: "installed" as const,
          warnings: [],
        };
      },
      codexProjectControlBroker: (input) => {
        if (!input.startLaunch) throw new Error("expected_start_launch");
        reservedLaunch = input.startLaunch;
        startAdmissionWorkspaceMode = input.startAdmissionWorkspaceMode;
        return {
          stopWorker: async () => {
            capacitySupervisorReapCalls += 1;
            await writeFile(
              progressPath,
              `${JSON.stringify({
                schemaVersion: 1,
                taskId: manifest.taskId,
                status: "stopped",
                updatedAt: new Date().toISOString(),
              })}\n`,
            );
            return { status: "applied" };
          },
          startWorker: async () => ({ status: "started" }),
        } as unknown as ProjectControlBroker;
      },
    };
    const args = {
      registryRootDir,
      controllerJobId: controller.jobId,
      jobId: manifest.jobId,
      confirmStart: true,
    };

    await writeFile(join(manifest.workspacePath, "DIRTY.txt"), "dirty\n");
    await expect(projectControlStartStoredJobView(args, deps)).rejects.toThrow(
      "project_control_pre_start_launch_binding_mismatch",
    );
    await rm(join(manifest.workspacePath, "DIRTY.txt"));

    await writeFile(
      resultPath,
      `${JSON.stringify({
        status: "blocked",
        reason: "provider_failure",
        changedFiles: [],
        blockers: ["provider_failure"],
        nextAction: "inspect",
      })}\n`,
    );
    await expect(
      projectControlStartStoredJobView(
        {
          ...args,
          forceStart: true,
        },
        deps,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(startAdmissionWorkspaceMode).toBe("clean_explicit_continuation");
    await writeCapacityResult();

    await writeFile(
      progressPath,
      `${JSON.stringify({
        schemaVersion: 1,
        taskId: manifest.taskId,
        status: "blocked",
        resultStatus: "waiting_capacity",
        reason: "account_unavailable",
        updatedAt: new Date().toISOString(),
        pid: process.pid,
      })}\n`,
    );
    await expect(
      projectControlStartStoredJobView(args, deps),
    ).resolves.toMatchObject({
      ok: true,
      capacitySupervisorReap: { status: "applied" },
      accountReservation: { accountId: "account-g" },
    });
    expect(capacitySupervisorReapCalls).toBe(1);
    await writeCapacityResult();

    const originalPrompt = await readFile(manifest.promptPath, "utf8");
    await writeFile(manifest.promptPath, "binding drift\n");
    await expect(projectControlStartStoredJobView(args, deps)).rejects.toThrow(
      "project_control_pre_start_launch_binding_mismatch:prompt_sha256",
    );
    await writeFile(manifest.promptPath, originalPrompt);

    const started = await projectControlStartStoredJobView(args, deps);
    expect(started).toMatchObject({
      ok: true,
      accountReservation: { accountId: "account-g" },
    });
    expect(bootstrapCalls).toBe(3);
    expect(reservedLaunch?.config.accounts).toEqual([{ name: "account-g" }]);
    expect(reservedLaunch?.config.maxAccountCycles).toBe(2);
    expect(startAdmissionWorkspaceMode).toBe("clean_capacity_continuation");
    expect(capacitySupervisorReapCalls).toBe(1);
    await authorizeProjectPreStartAdmissionLaunch({
      manifest,
      scope,
      workspaceMode: "clean_capacity_continuation",
    });
    expect(await readFile(plan.descriptor.receiptPath, "utf8")).toContain(
      '"launchAuthorizationCount": 2',
    );
  });
});

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
async function recordUnavailableAttempt(
  journal: InMemoryAttemptJournal,
  taskId: string,
  workspacePath: string,
  workspaceDirty = true,
): Promise<void> {
  const now = new Date("2026-07-14T00:00:00.000Z");
  await journal.startTask({
    taskId,
    workspaceRunId: "workspace-run",
    workspacePath,
    effectMode: "workspace_patch",
    provider: "codex",
    now,
  });
  await journal.appendAttempt({
    taskId,
    attempt: {
      taskId,
      attemptNumber: 1,
      accountId: "account-c",
      provider: "codex",
      startedAt: now,
      finishedAt: now,
      status: "blocked",
      failureReason: "account_unavailable",
      workspaceDirtyBefore: workspaceDirty,
      workspaceDirtyAfter: workspaceDirty,
      changedFiles: [],
    },
    now,
  });
  await journal.markPartial({
    taskId,
    status: "waiting_capacity",
    reason: "account_unavailable",
    now,
  });
}
