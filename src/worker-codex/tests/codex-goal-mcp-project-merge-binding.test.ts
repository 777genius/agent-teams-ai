import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccessBoundary,
  NetworkAccessMode,
} from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import {
  assertProjectMergeRebindRuntimeState,
  projectMergeBoundRetryStartRequired,
} from "../codex-goal-mcp-project-control-jobs";
import { codexGoalJobManifestPath, readCodexGoalJob } from "../codex-goal-jobs";
import {
  authorizeProjectPreStartAdmissionLaunch,
  withProjectPreStartAdmissionLaunchAuthorization,
} from "../application/project-control/codex-goal-project-pre-start-launch-authorization";
import { planProjectPreStartAdmission } from "../application/project-control/codex-goal-project-pre-start-admission";
import { replaceProjectRefillLaunchArtifacts } from "../application/project-control/codex-goal-project-refill";
import {
  projectControlWorkspaceLocks,
  withValidatedProjectWorkspaceLock,
} from "../codex-goal-project-workspace-lock";
import {
  callToolJson,
  git,
  gitInitRepository,
  gitStdout,
} from "./codex-goal-mcp-test-support";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("project merge-bound refill", () => {
  it("rejects live tmux and pid evidence even beside a strict terminal result", () => {
    const status = {
      recommendedAction: "review_completed" as const,
      warnings: [],
      workspaceDirty: false,
      resultStatus: "blocked",
    };
    expect(() =>
      assertProjectMergeRebindRuntimeState({
        status: { ...status, tmuxAlive: true },
        progressStale: false,
        strictTerminalResult: true,
      }),
    ).toThrow("project_control_merge_rebind_worker_still_running");
    expect(() =>
      assertProjectMergeRebindRuntimeState({
        status: { ...status, progressProcessAlive: true },
        progressStale: true,
        strictTerminalResult: true,
      }),
    ).toThrow("project_control_merge_rebind_worker_still_running");
  });

  it("materializes immutable divergent parents and reuses them on retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-merge-refill-"));
    roots.push(root);
    const source = join(root, "source");
    const remote = join(root, "origin.git");
    const registry = join(root, "worker-jobs", "registry");
    const controllerId = "test-controller";
    const workerId = "test-merge-worker";
    const workerRoot = join(root, "worker-jobs", workerId);
    const workerWorkspace = join(root, "worktrees", workerId);
    await mkdir(source, { recursive: true });
    await gitInitRepository(source);
    await Promise.all([
      writeFile(join(source, "controller.md"), "controller\n"),
      writeFile(join(source, "lane.md"), "lane\n"),
      writeFile(join(source, "README.md"), "base\n"),
      mkdir(join(source, "sandbox")),
    ]);
    await writeFile(join(source, "sandbox", ".keep"), "");
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "test: target"]);
    const targetCommit = (
      await gitStdout(source, ["rev-parse", "HEAD"])
    ).trim();
    await git(root, ["init", "--bare", remote]);
    await git(source, ["remote", "add", "origin", remote]);
    await git(source, ["push", "origin", "main"]);
    await git(source, ["switch", "-c", "base/current"]);
    await writeFile(join(source, "source.md"), "source\n");
    await git(source, ["add", "source.md"]);
    await git(source, ["commit", "-m", "test: source"]);
    const sourceCommit = (
      await gitStdout(source, ["rev-parse", "HEAD"])
    ).trim();
    await git(source, ["push", "origin", "base/current"]);
    await git(source, ["switch", "main"]);

    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "merge-refill-test", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir: registry,
        jobId: controllerId,
        jobRootDir: join(root, "worker-jobs", controllerId),
        authRootDir: join(root, "auth"),
        workspacePath: source,
        promptPath: join(root, "worker-jobs", controllerId, "prompt.md"),
        taskId: controllerId,
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "test",
          workspaceRoots: [source],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registry,
          authRoot: join(root, "auth"),
          jobIdPrefixes: ["test-"],
          tmuxSessionPrefixes: ["test-"],
          allowedBranches: ["main", "base/*", "test/*"],
          allowedGitRemotes: ["origin"],
          allowedAccountIds: ["account-a"],
          preStartAdmission: { required: true, mode: "serial-builtin" },
        },
      });
      const projectAccessScope = {
        projectId: "test",
        workspaceRoots: [source],
        worktreeRoots: [join(root, "worktrees")],
        registryRoot: registry,
        authRoot: join(root, "auth"),
        jobIdPrefixes: ["test-"],
        tmuxSessionPrefixes: ["test-"],
        allowedBranches: ["main", "base/*", "test/*"],
        allowedGitRemotes: ["origin"],
        allowedAccountIds: ["account-a"],
        preStartAdmission: { required: true, mode: "serial-builtin" as const },
      };
      const request = {
        registryRootDir: registry,
        controllerJobId: controllerId,
        jobId: workerId,
        jobRootDir: workerRoot,
        authRootDir: join(root, "auth"),
        sourceWorkspacePath: source,
        baseBranch: "main",
        requireCanonicalRemoteHead: true,
        mergeBinding: { sourceRemote: "origin", sourceBranch: "base/current" },
        newBranch: "test/merge-worker",
        workspacePath: workerWorkspace,
        promptBody: "Resolve merge.\n",
        taskId: workerId,
        accounts: ["account-a"],
        workerRole: "fastgate",
        preStartAdmission: {
          mode: "serial-builtin",
          contract: launchContract(root, workerWorkspace),
        },
        confirmPreStartAdmission: true,
        startWorker: false,
        confirmRefill: true,
      };
      const unboundRequest = {
        ...request,
        mergeBinding: undefined,
        preStartAdmission: {
          mode: "serial-builtin",
          contract: {
            ...launchContract(root, workerWorkspace),
            canonicalSha: targetCommit,
            phaseStartSha: targetCommit,
          },
        },
      };
      await expect(
        callToolJson(
          client,
          "codex_goal_project_refill_worker",
          unboundRequest,
        ),
      ).resolves.toMatchObject({ ok: true });
      const initialManifest = await readCodexGoalJob({
        registryRootDir: registry,
        jobId: workerId,
      });
      await authorizeProjectPreStartAdmissionLaunch({
        manifest: initialManifest,
        scope: projectAccessScope,
      });
      const originalPrompt = await readFile(initialManifest.promptPath, "utf8");
      const originalContract = await readFile(
        join(workerRoot, "pre-start-admission", "contract.json"),
        "utf8",
      );
      const originalReceipt = await readFile(
        join(workerRoot, "pre-start-admission", "receipt.json"),
        "utf8",
      );
      const originalState = await readFile(
        join(workerRoot, "pre-start-admission", "state.json"),
        "utf8",
      );
      const assertOriginalLaunchArtifacts = async () => {
        expect(await readFile(initialManifest.promptPath, "utf8")).toBe(
          originalPrompt,
        );
        expect(
          await readFile(
            join(workerRoot, "pre-start-admission", "contract.json"),
            "utf8",
          ),
        ).toBe(originalContract);
        expect(
          await readFile(
            join(workerRoot, "pre-start-admission", "state.json"),
            "utf8",
          ),
        ).toBe(originalState);
        expect(
          await readFile(
            join(workerRoot, "pre-start-admission", "receipt.json"),
            "utf8",
          ),
        ).toBe(originalReceipt);
      };
      const validReplacementAdmission = planProjectPreStartAdmission({
        value: {
          mode: "serial-builtin",
          contract: {
            ...launchContract(root, workerWorkspace),
            canonicalSha: targetCommit,
            phaseStartSha: targetCommit,
          },
        },
        confirmed: true,
        scope: projectAccessScope,
        manifest: initialManifest,
      });
      if (!validReplacementAdmission) {
        throw new Error("expected_valid_replacement_admission_plan");
      }
      await expect(
        replaceProjectRefillLaunchArtifacts({
          existing: initialManifest,
          expected: initialManifest,
          expectedExistingPromptBody: originalPrompt,
          promptBody: "replacement prompt\n",
          admission: validReplacementAdmission,
          scope: projectAccessScope,
          deps: {
            rename: async () => {
              throw new Error("injected_first_rename_failure");
            },
          },
        }),
      ).rejects.toThrow("injected_first_rename_failure");
      await assertOriginalLaunchArtifacts();

      let secondRenameCalls = 0;
      await expect(
        replaceProjectRefillLaunchArtifacts({
          existing: initialManifest,
          expected: initialManifest,
          expectedExistingPromptBody: originalPrompt,
          promptBody: "replacement prompt\n",
          admission: validReplacementAdmission,
          scope: projectAccessScope,
          deps: {
            rename: async (sourcePath, targetPath) => {
              secondRenameCalls += 1;
              if (secondRenameCalls === 2) {
                throw new Error("injected_second_rename_failure");
              }
              await rename(sourcePath, targetPath);
            },
          },
        }),
      ).rejects.toThrow("injected_second_rename_failure");
      await assertOriginalLaunchArtifacts();

      await expect(
        replaceProjectRefillLaunchArtifacts({
          existing: initialManifest,
          expected: initialManifest,
          expectedExistingPromptBody: originalPrompt,
          promptBody: "replacement prompt\n",
          admission: validReplacementAdmission,
          scope: projectAccessScope,
          deps: {
            writeFile: async () => {
              throw new Error("injected_write_failure");
            },
          },
        }),
      ).rejects.toThrow("injected_write_failure");
      await assertOriginalLaunchArtifacts();

      await expect(
        replaceProjectRefillLaunchArtifacts({
          existing: initialManifest,
          expected: initialManifest,
          expectedExistingPromptBody: originalPrompt,
          promptBody: "replacement prompt\n",
          admission: validReplacementAdmission,
          scope: projectAccessScope,
          deps: {
            prepareAdmission: async () => {
              throw new Error("injected_prepare_failure");
            },
          },
        }),
      ).rejects.toThrow("injected_prepare_failure");
      await assertOriginalLaunchArtifacts();

      const invalidAdmission = planProjectPreStartAdmission({
        value: {
          mode: "serial-builtin",
          contract: {
            ...launchContract(root, workerWorkspace),
            canonicalSha: "9".repeat(40),
            phaseStartSha: "9".repeat(40),
          },
        },
        confirmed: true,
        scope: projectAccessScope,
        manifest: initialManifest,
      });
      if (!invalidAdmission) throw new Error("expected_invalid_admission_plan");
      await expect(
        replaceProjectRefillLaunchArtifacts({
          existing: initialManifest,
          expected: initialManifest,
          expectedExistingPromptBody: originalPrompt,
          promptBody: "replacement prompt\n",
          admission: invalidAdmission,
          scope: projectAccessScope,
        }),
      ).rejects.toThrow("project_control_pre_start_workspace_head_mismatch");
      expect(await readFile(initialManifest.promptPath, "utf8")).toBe(
        originalPrompt,
      );
      expect(
        await readFile(
          join(workerRoot, "pre-start-admission", "contract.json"),
          "utf8",
        ),
      ).toBe(originalContract);
      expect(
        await readFile(
          join(workerRoot, "pre-start-admission", "receipt.json"),
          "utf8",
        ),
      ).toBe(originalReceipt);
      const latestResultPath = join(
        workerRoot,
        `${workerId}.latest-result.json`,
      );
      const strictBlockedResult = {
        status: "blocked",
        reason: "runtime_launch_binding_missing",
        changedFiles: [],
        evidence: ["runtime_launch_binding_missing"],
        blockers: ["merge_binding_missing"],
        nextAction: "recover",
      };
      for (const invalid of [
        { ...strictBlockedResult, status: "completed" },
        { ...strictBlockedResult, status: "aborted" },
      ]) {
        await writeFile(latestResultPath, `${JSON.stringify(invalid)}\n`);
        await expect(
          callToolJson(client, "codex_goal_project_refill_worker", request),
        ).resolves.toMatchObject({
          ok: false,
          error: "project_control_merge_rebind_terminal_result_required",
        });
        await assertOriginalLaunchArtifacts();
      }
      await writeFile(latestResultPath, '{"status":"blocked"\n');
      await expect(
        callToolJson(client, "codex_goal_project_refill_worker", request),
      ).resolves.toMatchObject({
        ok: false,
        error: "project_control_merge_rebind_terminal_result_required",
      });
      await assertOriginalLaunchArtifacts();
      await writeFile(
        latestResultPath,
        `${JSON.stringify(strictBlockedResult)}\n`,
      );

      const promptBefore = await readFile(
        join(workerRoot, "prompt.md"),
        "utf8",
      );
      await expect(
        callToolJson(client, "codex_goal_project_refill_worker", {
          ...request,
          newBranch: "test/different-branch",
        }),
      ).rejects.toThrow("project_control_existing_worktree_branch_mismatch");
      expect(await readFile(join(workerRoot, "prompt.md"), "utf8")).toBe(
        promptBefore,
      );
      await expect(
        callToolJson(client, "codex_goal_project_refill_worker", {
          ...request,
          model: "different-model",
        }),
      ).rejects.toThrow(
        "project_control_merge_rebind_existing_job_mismatch:model",
      );
      expect(await readFile(join(workerRoot, "prompt.md"), "utf8")).toBe(
        promptBefore,
      );

      await writeFile(
        join(workerRoot, `${workerId}.progress.json`),
        `${JSON.stringify({
          schemaVersion: 1,
          taskId: workerId,
          status: "running",
          updatedAt: new Date().toISOString(),
          pid: process.pid,
        })}\n`,
      );
      await expect(
        callToolJson(client, "codex_goal_project_refill_worker", request),
      ).rejects.toThrow("project_control_merge_rebind_worker_still_running");
      await rm(join(workerRoot, `${workerId}.progress.json`));

      await writeFile(join(workerWorkspace, "unexpected.txt"), "dirty\n");
      await expect(
        callToolJson(client, "codex_goal_project_refill_worker", request),
      ).rejects.toThrow("project_control_existing_worktree_dirty");
      await rm(join(workerWorkspace, "unexpected.txt"));

      const result = await callToolJson(
        client,
        "codex_goal_project_refill_worker",
        request,
      );
      expect(result).toMatchObject({
        ok: true,
        canonicalRemoteHead: { oid: targetCommit },
      });
      const contract = JSON.parse(
        await readFile(
          join(workerRoot, "pre-start-admission", "contract.json"),
          "utf8",
        ),
      );
      expect(contract).toMatchObject({
        canonicalSha: targetCommit,
        phaseStartSha: targetCommit,
        merge: { sourceCommit, expectedTargetCommit: targetCommit },
      });
      const receipt = JSON.parse(
        await readFile(
          join(workerRoot, "pre-start-admission", "receipt.json"),
          "utf8",
        ),
      );
      expect(receipt.merge).toEqual(contract.merge);
      expect(await readFile(join(workerRoot, "prompt.md"), "utf8")).toContain(
        `- source commit: ${sourceCommit}`,
      );
      expect(
        JSON.parse(
          await readFile(
            codexGoalJobManifestPath({
              registryRootDir: registry,
              jobId: workerId,
            }),
            "utf8",
          ),
        ).createdAt,
      ).toBe(initialManifest.createdAt);
      const reboundManifest = await readCodexGoalJob({
        registryRootDir: registry,
        jobId: workerId,
      });
      expect(await projectMergeBoundRetryStartRequired(reboundManifest)).toBe(
        true,
      );
      let brokerStartCalls = 0;
      await expect(
        withProjectPreStartAdmissionLaunchAuthorization(
          {
            manifest: reboundManifest,
            scope: projectAccessScope,
            workspaceMode: "clean_explicit_continuation",
          },
          async () => {
            brokerStartCalls += 1;
            throw new Error("injected_start_failure");
          },
        ),
      ).rejects.toThrow("injected_start_failure");
      expect(await projectMergeBoundRetryStartRequired(reboundManifest)).toBe(
        true,
      );
      const canonicalWorkerWorkspace = await realpath(workerWorkspace);
      await Promise.all(
        ["retry-a", "retry-b"].map(
          async (owner) =>
            await withValidatedProjectWorkspaceLock({
              locks: projectControlWorkspaceLocks(registry),
              scope: projectAccessScope,
              requestedWorkspacePath: workerWorkspace,
              expectedCanonicalWorkspacePath: canonicalWorkerWorkspace,
              owner,
              effect: async () => {
                if (
                  !(await projectMergeBoundRetryStartRequired(reboundManifest))
                ) {
                  return;
                }
                await withProjectPreStartAdmissionLaunchAuthorization(
                  {
                    manifest: reboundManifest,
                    scope: projectAccessScope,
                    workspaceMode: "clean_explicit_continuation",
                  },
                  async () => {
                    brokerStartCalls += 1;
                  },
                );
              },
            }),
        ),
      );
      expect(await projectMergeBoundRetryStartRequired(reboundManifest)).toBe(
        false,
      );
      expect(brokerStartCalls).toBe(2);
      expect(
        await callToolJson(client, "codex_goal_project_refill_worker", request),
      ).toMatchObject({ ok: true, worktree: { status: "noop" } });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function launchContract(root: string, workspace: string) {
  return {
    kind: "worker-launch",
    format: 1,
    baseSha: "1".repeat(40),
    packetRevision: "phase-01-r1",
    controllerPacket: "controller.md",
    lanePacket: "lane.md",
    phaseId: "phase-01",
    laneId: "merge",
    inputPatchHash: null,
    reviewKind: "implementation",
    ownedPaths: ["source.md"],
    mandatoryDocs: ["controller.md", "lane.md"],
    mandatoryScripts: [],
    mandatoryFixtures: [],
    requiredChecks: [{ id: "focused", cwd: "sandbox", command: "true" }],
    executionPolicy: {
      mode: "sandbox-only",
      sandboxRoot: join(workspace, "sandbox"),
      forbiddenRealProjects: [join(root, "real")],
    },
  };
}
