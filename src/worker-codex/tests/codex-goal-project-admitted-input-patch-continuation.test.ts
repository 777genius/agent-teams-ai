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
import type { CodexGoalLaunchInput, CodexGoalStatus } from "../codex-goal-ops";
import { resolveProjectPreStartContinuation } from "../codex-goal-project-continuation-runtime";
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
import { tryMaterializeTerminalCodexGoalHandoff } from "../codex-goal-terminal-handoff-materialization";
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

  it("resumes only a strict prewarm-before-attempt result for the admitted patch", async () => {
    const fixture = await createBuiltinFixture();
    const plan = fixture.plan();
    const manifest = {
      ...fixture.storedManifest,
      projectPreStartAdmission: plan.descriptor,
    };
    const resultPath = join(fixture.root, "prewarm-result.json");
    const changedFiles = ["src/example.ts"];
    const result = {
      schemaVersion: 1,
      taskId: manifest.taskId,
      status: "partial",
      reason: "prewarm_failed",
      changedFiles,
      evidence: ["provider prewarm failed before any task attempt"],
      blockers: ["prewarm_failed"],
      nextAction: "preserve_patch",
      details: {
        errorName: "WrappedProviderError",
        errorCode: "subscription_worker_prewarm_failed",
        baseCommit: "a".repeat(40),
      },
    };
    const status = {
      tmuxAlive: false,
      workspaceDirty: true,
      changedFiles,
      resultExists: true,
      resultPath,
      resultStatus: "partial",
      resultReason: "prewarm_failed",
      recommendedAction: "inspect_dirty_failure",
      warnings: [],
    } as CodexGoalStatus;
    const launch = {
      config: { taskId: manifest.taskId },
    } as CodexGoalLaunchInput;

    await writeFile(resultPath, `${JSON.stringify(result)}\n`);
    await expect(
      resolveProjectPreStartContinuation({ manifest, launch, status }),
    ).resolves.toEqual({
      kind: "prewarm_before_attempt",
      workspaceMode: "admitted_input_patch_continuation",
    });

    await writeFile(
      resultPath,
      `${JSON.stringify({ ...result, evidence: ["provider failed"] })}\n`,
    );
    await expect(
      resolveProjectPreStartContinuation({ manifest, launch, status }),
    ).resolves.toBeUndefined();

    await writeFile(resultPath, `${JSON.stringify(result)}\n`);
    await expect(
      resolveProjectPreStartContinuation({
        manifest,
        launch,
        status: { ...status, changedFiles: ["src/drift.ts"] },
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveProjectPreStartContinuation({
        manifest,
        launch,
        status: { ...status, recommendedAction: "review_completed" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveProjectPreStartContinuation({
        manifest,
        launch,
        status: { ...status, progressResultReason: "unknown_error" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveProjectPreStartContinuation({
        manifest,
        launch,
        status,
        reviewedOutputId: "b".repeat(64),
      }),
    ).resolves.toBeUndefined();
  });

  it("resumes a legacy unsupported-model prewarm transcript only for the unchanged admitted patch", async () => {
    const fixture = await createBuiltinFixture();
    const plan = fixture.plan();
    const manifest = {
      ...fixture.storedManifest,
      projectPreStartAdmission: plan.descriptor,
    };
    const resultPath = join(fixture.root, "legacy-prewarm-result.json");
    const changedFiles = ["src/example.ts"];
    const rawCause = legacyUnsupportedModelPrewarmRawCause();
    const result = {
      schemaVersion: 1,
      taskId: manifest.taskId,
      status: "failed",
      reason: "unknown_error",
      changedFiles,
      evidence: ["safe_execution_status:failed"],
      blockers: ["unknown_error"],
      nextAction: "preserve_patch",
      details: {
        baseCommit: "a".repeat(40),
        rawCause,
      },
    };
    const status = {
      tmuxAlive: false,
      workspaceDirty: true,
      changedFiles,
      resultExists: true,
      resultPath,
      resultStatus: "failed",
      resultReason: "unknown_error",
      recommendedAction: "inspect_dirty_failure",
      warnings: [],
    } as CodexGoalStatus;
    const launch = {
      config: { taskId: manifest.taskId },
    } as CodexGoalLaunchInput;

    await writeFile(resultPath, `${JSON.stringify(result)}\n`);
    await expect(
      resolveProjectPreStartContinuation({ manifest, launch, status }),
    ).resolves.toEqual({
      kind: "prewarm_before_attempt",
      workspaceMode: "admitted_input_patch_continuation",
    });

    for (const rejectedRawCause of [
      rawCause.replace("Respond with OK only.", "Review the admitted patch."),
      rawCause.replace("invalid_request_error", "server_error"),
      rawCause.replace("status 400", "status 503"),
      rawCause.replace(
        "model is not supported when using Codex with a ChatGPT account",
        "provider request failed",
      ),
      "ordinary_unknown_runtime_failure",
    ]) {
      await writeFile(
        resultPath,
        `${JSON.stringify({
          ...result,
          details: { ...result.details, rawCause: rejectedRawCause },
        })}\n`,
      );
      await expect(
        resolveProjectPreStartContinuation({ manifest, launch, status }),
      ).resolves.toBeUndefined();
    }

    await writeFile(resultPath, `${JSON.stringify(result)}\n`);
    await expect(
      resolveProjectPreStartContinuation({
        manifest,
        launch,
        status: { ...status, changedFiles: ["src/drift.ts"] },
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveProjectPreStartContinuation({
        manifest,
        launch,
        status,
        reviewedOutputId: "b".repeat(64),
      }),
    ).resolves.toBeUndefined();
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
    const providerToken = ["sk-", "v".repeat(24)].join("");
    await writeFile(
      join(workspacePath, "src", "example.ts"),
      `export const providerToken = ${JSON.stringify(providerToken)};\n`,
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
      reviewKind: "review",
      ownedPaths: ["src/owned.ts"],
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
    const resultPath = join(
      manifest.jobRootDir,
      `${manifest.taskId}.latest-result.json`,
    );
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

    const reconnectResult = {
      schemaVersion: 1,
      provider: "codex",
      runId: manifest.jobId,
      taskId: manifest.taskId,
      status: "partial",
      reason: "unknown_error",
      updatedAt: new Date().toISOString(),
      changedFiles: ["src/example.ts"],
      evidence: ["safe_execution_status:failed"],
      blockers: ["unknown_error"],
      nextAction: "preserve_patch",
      details: {
        rawCause: "ordinary_unknown_runtime_failure",
      },
    };
    const reconnectAttemptAt = new Date("2026-07-14T00:01:00.000Z");
    const reconnectFailureDetails = {
      rawCause: "codex_app_server_reconnect_timeout:Reconnecting... 2/5",
    };
    await journal.appendAttempt({
      taskId: manifest.taskId,
      attempt: {
        taskId: manifest.taskId,
        attemptNumber: 2,
        accountId: "account-g",
        provider: "codex",
        startedAt: reconnectAttemptAt,
        finishedAt: reconnectAttemptAt,
        status: "blocked",
        failureReason: "unknown_error",
        failureDetails: reconnectFailureDetails,
        workspaceDirtyBefore: true,
        workspaceDirtyAfter: true,
        changedFiles: [],
      },
      now: reconnectAttemptAt,
    });
    await journal.markPartial({
      taskId: manifest.taskId,
      status: "partial",
      reason: "unknown_error",
      details: reconnectFailureDetails,
      now: reconnectAttemptAt,
    });
    await writeFile(resultPath, `${JSON.stringify(reconnectResult)}\n`);
    await expect(
      projectControlStartStoredJobView(
        { ...args, forceStart: true },
        continuationDeps,
      ),
    ).rejects.toThrow(
      "project_control_reviewed_dirty_continuation_output_required",
    );

    await writeFile(
      resultPath,
      `${JSON.stringify({
        ...reconnectResult,
        status: "failed",
        details: {
          ...reconnectFailureDetails,
        },
      })}\n`,
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
      "admitted_input_patch_continuation",
    );
    expect(reservedLaunch?.config.maxAccountCycles).toBe(3);

    await writeFile(
      resultPath,
      `${JSON.stringify({
        ...reconnectResult,
        details: {
          rawCause:
            "codex_app_server_error:This request was rejected before the verifier could run.",
        },
      })}\n`,
    );
    await expect(
      projectControlStartStoredJobView(
        { ...args, forceStart: true },
        continuationDeps,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(startAdmissionWorkspaceModes.at(-1)).toBe(
      "admitted_input_patch_continuation",
    );

    await writeFile(
      resultPath,
      `${JSON.stringify({
        ...reconnectResult,
        status: "failed",
        details: {
          baseCommit: contract.baseSha,
          rawCause: legacyUnsupportedModelPrewarmRawCause(),
        },
      })}\n`,
    );
    await expect(
      projectControlStartStoredJobView(
        { ...args, forceStart: true },
        continuationDeps,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(startAdmissionWorkspaceModes.at(-1)).toBe(
      "admitted_input_patch_continuation",
    );

    await writeFile(
      resultPath,
      `${JSON.stringify({
        ...reconnectResult,
        details: {
          rawCause: "ordinary_unknown_runtime_failure",
        },
      })}\n`,
    );
    await expect(
      projectControlStartStoredJobView(
        { ...args, forceStart: true },
        continuationDeps,
      ),
    ).rejects.toThrow(
      "project_control_reviewed_dirty_continuation_output_required",
    );

    await writeFile(
      resultPath,
      `${JSON.stringify({
        ...reconnectResult,
        details: {
          ...reconnectFailureDetails,
        },
      })}\n`,
    );
    await expect(
      projectControlStartStoredJobView(
        { ...args, forceStart: true },
        continuationDeps,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(startAdmissionWorkspaceModes.at(-1)).toBe(
      "admitted_input_patch_continuation",
    );
    expect(reservedLaunch?.config.maxAccountCycles).toBe(3);

    if (!reservedLaunch) throw new Error("expected reserved launch");
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
    const interruptedHandoff = await tryMaterializeTerminalCodexGoalHandoff({
      jobId: manifest.jobId,
      taskId: manifest.taskId,
      workspacePath,
      jobRootDir: manifest.jobRootDir,
    });
    if (!interruptedHandoff.continuationFingerprint) {
      throw new Error("expected interrupted continuation fingerprint");
    }
    const interruptedResultPath = resultPath;
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
        baseCommit: interruptedHandoff.continuationFingerprint.baseCommit,
        handoffArtifactError: interruptedHandoff.errorCode,
        continuationWorkspaceFingerprintSchema:
          interruptedHandoff.continuationFingerprint.schema,
        continuationWorkspaceFingerprintSha256:
          interruptedHandoff.continuationFingerprint.sha256,
      },
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
    ).rejects.toThrow(
      "project_control_runtime_interruption_snapshot_unavailable",
    );

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

describe("clean-first producer runtime interruption continuation", () => {
  it("accepts the runtime-captured owned patch without an original verified input patch", async () => {
    const fixture = await createBuiltinFixture();
    const contract = withWorkKey({
      ...fixture.contract,
      reviewKind: "implementation",
      inputPatchHash: null,
      ownedPaths: ["src/"],
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
      scope: fixture.scope,
      manifest: fixture.manifest,
    });
    if (!plan) throw new Error("expected admission plan");
    const manifest: CodexGoalJobManifest = {
      ...fixture.storedManifest,
      projectPreStartAdmission: plan.descriptor,
    };
    await prepareProjectPreStartAdmission({
      plan,
      manifest,
      scope: fixture.scope,
    });
    await authorizeProjectPreStartAdmissionLaunch({
      manifest,
      scope: fixture.scope,
    });

    await mkdir(join(manifest.workspacePath, "src"), { recursive: true });
    await writeFile(
      join(manifest.workspacePath, "src", "example.ts"),
      "export const value = 1;\n",
    );
    await writeFile(
      join(manifest.workspacePath, "src", "second.ts"),
      "export const second = 1;\n",
    );
    const handoff = await materializeCodexGoalHandoffArtifacts({
      workerJobId: manifest.jobId,
      taskId: manifest.taskId,
      workspacePath: manifest.workspacePath,
      jobRootDir: manifest.jobRootDir,
    });
    if (!handoff) throw new Error("expected interrupted handoff");
    const resultPath = join(
      manifest.jobRootDir,
      `${manifest.taskId}.latest-result.json`,
    );
    await writeFile(
      resultPath,
      `${JSON.stringify({
        schemaVersion: 1,
        taskId: manifest.taskId,
        status: "partial",
        reason: "runtime_interrupted",
        updatedAt: new Date().toISOString(),
        changedFiles: ["src/example.ts", "src/second.ts"],
        evidence: ["safe_execution_status:partial"],
        blockers: ["runtime_interrupted"],
        nextAction: "preserve_patch",
        artifacts: handoff.artifacts,
      })}\n`,
    );

    await expect(
      assertProjectPreStartAdmissionLaunchBinding({
        manifest,
        scope: fixture.scope,
        workspaceMode: "admitted_input_patch_runtime_continuation",
      }),
    ).resolves.toBeUndefined();

    await writeFile(
      resultPath,
      `${JSON.stringify({
        schemaVersion: 1,
        taskId: manifest.taskId,
        status: "partial",
        reason: "account_unavailable",
        updatedAt: new Date().toISOString(),
        changedFiles: ["src/example.ts", "src/second.ts"],
        evidence: ["safe_execution_status:partial"],
        blockers: ["account_unavailable"],
        nextAction: "switch_account",
        artifacts: handoff.artifacts,
      })}\n`,
    );
    const status = {
      workspaceDirty: true,
      recommendedAction: "continue_after_capacity",
      resultExists: true,
      resultPath,
      resultStatus: "partial",
      resultReason: "account_unavailable",
      warnings: [],
    } as CodexGoalStatus;
    await expect(
      resolveProjectPreStartContinuation({
        manifest,
        launch: {
          config: { taskId: manifest.taskId },
        } as CodexGoalLaunchInput,
        status,
      }),
    ).resolves.toEqual({
      kind: "capacity",
      workspaceMode: "admitted_input_patch_continuation",
    });
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
        status: "partial",
        reason: "runtime_interrupted",
        changedFiles: [],
        evidence: ["runtime interruption captured"],
        blockers: ["runtime_interrupted"],
        nextAction: "continue",
      })}\n`,
    );
    await expect(
      projectControlStartStoredJobView(
        {
          ...args,
          forceStart: true,
        },
        {
          ...deps,
          safeExecutionJournal: new InMemoryAttemptJournal(),
        },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(startAdmissionWorkspaceMode).toBe("clean_explicit_continuation");

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
    expect(bootstrapCalls).toBe(4);
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

function legacyUnsupportedModelPrewarmRawCause(): string {
  return [
    "Codex prewarm transcript:",
    "user",
    "Respond with OK only.",
    '{"error":{"type":"invalid_request_error","message":"The \'gpt-5.6-sol\' model is not supported when using Codex with a ChatGPT account"}}',
    "request failed with status 400",
  ].join("\n");
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
