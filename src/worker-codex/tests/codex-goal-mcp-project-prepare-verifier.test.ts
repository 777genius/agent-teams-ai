import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  AccessBoundary,
  InMemoryAttemptJournal,
  NetworkAccessMode,
  ReviewDecisionStatus,
  type ProjectControlBroker,
} from "@vioxen/subscription-runtime/worker-core";
import { materializeCodexGoalHandoffArtifacts } from "../codex-goal-handoff-artifacts";
import {
  codexGoalJobManifestPath,
  parseCodexGoalJobManifest,
  readCodexGoalJob,
} from "../codex-goal-jobs";
import type { CodexGoalLaunchInput } from "../codex-goal-ops";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import {
  projectControlStartStoredJobView,
  type CodexGoalMcpProjectControlActionsDeps,
} from "../codex-goal-mcp-project-control-actions";
import { assertProjectPreStartAdmissionLaunchBinding } from "../application/project-control/codex-goal-project-pre-start-admission";
import { authorizeProjectPreStartAdmissionLaunch } from "../application/project-control/codex-goal-project-pre-start-launch-authorization";
import {
  captureReviewedWorkerOutput,
  commitReviewedWorkerOutputReviewAttestation,
  localReviewedWorkerOutputDeps,
  reviewedWorkerOutputRoot,
} from "../reviewed-worker-output";
import {
  callToolJson,
  git,
  gitInitRepository,
  gitStdout,
} from "./codex-goal-mcp-test-support";
import {
  directoryEntries,
  projectScope,
  recordUnavailableAttempt,
  writeRejectedProducerLedger,
} from "./codex-goal-mcp-project-prepare-verifier-test-support";

describe("project verifier preparation", () => {
  it("previews and atomically materializes two ordered reviewed outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "verifier-reviewed-aggregate-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "controller");
    const sourceWorkspacePath = join(root, "workspaces", "canonical");
    const verifierWorkspacePath = join(root, "worktrees", "verifier");
    const remotePath = join(root, "remote.git");
    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await git(root, ["init", "--bare", remotePath]);
      await Promise.all([
        mkdir(sourceWorkspacePath, { recursive: true }),
        mkdir(join(root, "control", "consumed-output-ledger", "items"), {
          recursive: true,
        }),
      ]);
      await gitInitRepository(sourceWorkspacePath);
      await Promise.all([
        writeFile(join(sourceWorkspacePath, "README.md"), "base\n"),
        writeFile(join(sourceWorkspacePath, "controller.md"), "controller\n"),
        writeFile(join(sourceWorkspacePath, "lane.md"), "lane\n"),
        writeFile(join(sourceWorkspacePath, "a.txt"), "base a\n"),
        writeFile(join(sourceWorkspacePath, "b.txt"), "base b\n"),
        mkdir(join(sourceWorkspacePath, "checks")),
      ]);
      await writeFile(join(sourceWorkspacePath, "checks", ".keep"), "");
      await git(sourceWorkspacePath, ["add", "."]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      const canonicalSha = await revision(sourceWorkspacePath);
      await git(sourceWorkspacePath, ["remote", "add", "origin", remotePath]);
      await git(sourceWorkspacePath, ["push", "-u", "origin", "HEAD:main"]);

      const reviewedRoot = reviewedWorkerOutputRoot(registryRootDir);
      const a = await createApprovedReviewedOutput({
        root,
        sourceWorkspacePath,
        reviewedRoot,
        workerJobId: "worker-a",
        changedFile: "a.txt",
        content: "reviewed a\n",
      });
      const b = await createApprovedReviewedOutput({
        root,
        sourceWorkspacePath,
        reviewedRoot,
        workerJobId: "worker-b",
        changedFile: "b.txt",
        content: "reviewed b\n",
      });
      const overlap = await createApprovedReviewedOutput({
        root,
        sourceWorkspacePath,
        reviewedRoot,
        workerJobId: "worker-overlap",
        changedFile: "a.txt",
        content: "overlap a\n",
      });
      const differentBase = await createApprovedReviewedOutput({
        root,
        sourceWorkspacePath,
        reviewedRoot,
        workerJobId: "worker-different-base",
        changedFile: "different-base.txt",
        content: "different base\n",
        advanceBase: true,
      });

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await createControllerJob({
        client,
        root,
        registryRootDir,
        controllerJobRoot,
        sourceWorkspacePath,
      });
      const baseArgs = {
        registryRootDir,
        controllerJobId: "project-controller",
        reviewedOutputIds: [a.reviewedOutputId, b.reviewedOutputId],
        jobId: "project-aggregate-verifier",
        taskId: "project-aggregate-verifier",
        sourceWorkspacePath,
        baseBranch: "origin/main",
        newBranch: "review/project-aggregate-verifier",
        workspacePath: verifierWorkspacePath,
        promptBody: "Review ordered immutable outputs.\n",
        accounts: ["account-a"],
        workerRole: "reviewer",
        startWorker: false,
        executionMode: "sync",
      };
      const preview = await callToolJson(
        client,
        "codex_goal_project_prepare_verifier",
        baseArgs,
      );
      expect(preview).toMatchObject({
        ok: false,
        reason: "confirm_refill_required",
        requiredInputPatchHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        reviewedOutputAggregate: {
          reviewedOutputIds: [a.reviewedOutputId, b.reviewedOutputId],
          baseCommit: canonicalSha,
          changedFiles: ["a.txt", "b.txt"],
        },
      });
      const requiredInputPatchHash = String(preview.requiredInputPatchHash);
      await expect(
        callToolJson(client, "codex_goal_project_prepare_verifier", {
          ...baseArgs,
          producerJobId: "project-producer",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: "project_control_verifier_input_source_conflict",
      });
      await expect(
        callToolJson(client, "codex_goal_project_prepare_verifier", {
          ...baseArgs,
          reviewedOutputIds: [a.reviewedOutputId, "f".repeat(64)],
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: "reviewed_worker_output_not_found",
      });
      await expect(
        callToolJson(client, "codex_goal_project_prepare_verifier", {
          ...baseArgs,
          reviewedOutputIds: [a.reviewedOutputId, overlap.reviewedOutputId],
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: "reviewed_output_aggregate_changed_file_overlap:a.txt",
      });
      await expect(
        callToolJson(client, "codex_goal_project_prepare_verifier", {
          ...baseArgs,
          reviewedOutputIds: [
            a.reviewedOutputId,
            differentBase.reviewedOutputId,
          ],
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: "reviewed_output_aggregate_base_commit_mismatch",
      });
      const aPatch = await readFile(a.patchPath, "utf8");
      await writeFile(a.patchPath, `${aPatch}tampered\n`);
      await expect(
        callToolJson(client, "codex_goal_project_prepare_verifier", baseArgs),
      ).resolves.toMatchObject({
        ok: false,
        error: "reviewed_worker_output_manifest_patch_hash_mismatch",
      });
      await writeFile(a.patchPath, aPatch);

      const admission = (inputPatchHash: string, sandboxRoot: string) => ({
        mode: "serial-builtin",
        contract: {
          kind: "worker-launch",
          format: 1,
          canonicalSha,
          baseSha: canonicalSha,
          phaseStartSha: canonicalSha,
          packetRevision: "aggregate-review-r1",
          controllerPacket: "controller.md",
          lanePacket: "lane.md",
          phaseId: "phase-02",
          laneId: "aggregate-review",
          inputPatchHash,
          reviewKind: "review",
          ownedPaths: ["a.txt", "b.txt"],
          mandatoryDocs: ["README.md", "controller.md", "lane.md"],
          mandatoryScripts: [],
          mandatoryFixtures: [],
          requiredChecks: [
            {
              id: "focused",
              cwd: "checks",
              command: "cd .. && git diff --check",
            },
          ],
          executionPolicy: {
            mode: "sandbox-only",
            sandboxRoot,
            forbiddenRealProjects: [join(root, "real-user-project")],
          },
        },
      });
      const rollbackWorkspacePath = join(
        root,
        "worktrees",
        "rollback-verifier",
      );
      await expect(
        callToolJson(client, "codex_goal_project_prepare_verifier", {
          ...baseArgs,
          reviewedOutputIds: [b.reviewedOutputId, a.reviewedOutputId],
          jobId: "project-rollback-verifier",
          taskId: "project-rollback-verifier",
          newBranch: "review/project-rollback-verifier",
          workspacePath: rollbackWorkspacePath,
          preStartAdmission: admission(
            requiredInputPatchHash,
            rollbackWorkspacePath,
          ),
          confirmPreStartAdmission: true,
          confirmRefill: true,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining(
          "project_control_pre_start_verified_input_patch_mismatch",
        ),
      });
      await expect(
        readFile(
          join(registryRootDir, "project-rollback-verifier", "job.json"),
          "utf8",
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(
          join(
            root,
            "worker-jobs",
            "project-rollback-verifier",
            "reviewed-output-aggregate",
            "input.patch",
          ),
          "utf8",
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await gitStdout(sourceWorkspacePath, [
          "worktree",
          "list",
          "--porcelain",
        ]),
      ).not.toContain(rollbackWorkspacePath);

      const result = await callToolJson(
        client,
        "codex_goal_project_prepare_verifier",
        {
          ...baseArgs,
          preStartAdmission: admission(
            requiredInputPatchHash,
            verifierWorkspacePath,
          ),
          confirmPreStartAdmission: true,
          confirmRefill: true,
        },
      );

      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(result).toMatchObject({
        ok: true,
        mode: "project_control_prepare_verifier",
        reviewedOutputAggregate: {
          reviewedOutputIds: [a.reviewedOutputId, b.reviewedOutputId],
          patchSha256: requiredInputPatchHash,
        },
        worktree: { status: "applied" },
        startSkipped: true,
      });
      expect(await readFile(join(verifierWorkspacePath, "a.txt"), "utf8")).toBe(
        "reviewed a\n",
      );
      expect(await readFile(join(verifierWorkspacePath, "b.txt"), "utf8")).toBe(
        "reviewed b\n",
      );
      const manifest = await readCodexGoalJob({
        registryRootDir,
        jobId: "project-aggregate-verifier",
      });
      const receipt = JSON.parse(
        await readFile(manifest.projectPreStartAdmission!.receiptPath, "utf8"),
      ) as Record<string, unknown>;
      expect(receipt.inputPatchArtifactSha256).toBe(requiredInputPatchHash);
      expect(receipt.workspaceStagedPatchSha256).toMatch(/^[a-f0-9]{64}$/);
      const provenance = JSON.parse(
        await readFile(
          join(
            manifest.jobRootDir,
            "reviewed-output-aggregate",
            "provenance.json",
          ),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(provenance).toMatchObject({
        reviewedOutputIds: [a.reviewedOutputId, b.reviewedOutputId],
        patchSha256: requiredInputPatchHash,
      });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["sync", "bounded"] as const)(
    "uses pinned remote HEAD when the local branch and tracking ref are stale (%s)",
    async (executionMode) => {
      const root = await mkdtemp(join(tmpdir(), "verifier-remote-head-"));
      const registryRootDir = join(root, "worker-jobs", "registry");
      const controllerJobRoot = join(root, "worker-jobs", "controller");
      const producerJobRoot = join(root, "worker-jobs", "producer");
      const sourceWorkspacePath = join(root, "workspaces", "canonical");
      const producerWorkspacePath = join(root, "worktrees", "producer");
      const verifierWorkspacePath = join(root, "worktrees", "verifier");
      const remediationWorkspacePath = join(root, "worktrees", "remediation");
      const remotePath = join(root, "remote.git");
      const server = createCodexGoalMcpServer();
      const client = new Client({ name: "test", version: "0.0.0" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const previousRunnerPath =
        process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_OPERATION_CLI_PATH;

      try {
        await git(root, ["init", "--bare", remotePath]);
        await Promise.all([
          mkdir(sourceWorkspacePath, { recursive: true }),
          mkdir(join(root, "control", "consumed-output-ledger", "items"), {
            recursive: true,
          }),
        ]);
        await gitInitRepository(sourceWorkspacePath);
        await Promise.all([
          writeFile(join(sourceWorkspacePath, "README.md"), "base\n"),
          writeFile(join(sourceWorkspacePath, "controller.md"), "controller\n"),
          writeFile(join(sourceWorkspacePath, "lane.md"), "lane\n"),
          writeFile(join(sourceWorkspacePath, "feature.txt"), "base\n"),
          mkdir(join(sourceWorkspacePath, "checks")),
        ]);
        await writeFile(join(sourceWorkspacePath, "checks", ".keep"), "");
        await git(sourceWorkspacePath, ["add", "."]);
        await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
        const producerBase = await revision(sourceWorkspacePath);
        await git(sourceWorkspacePath, ["remote", "add", "origin", remotePath]);
        await git(sourceWorkspacePath, ["push", "-u", "origin", "HEAD:main"]);

        await git(root, ["clone", sourceWorkspacePath, producerWorkspacePath]);
        await git(producerWorkspacePath, [
          "config",
          "user.email",
          "test@example.com",
        ]);
        await git(producerWorkspacePath, ["config", "user.name", "Test User"]);
        await writeFile(
          join(producerWorkspacePath, "feature.txt"),
          "producer\n",
        );
        const handoff = await materializeCodexGoalHandoffArtifacts({
          workerJobId: "project-producer",
          taskId: "project-producer",
          workspacePath: producerWorkspacePath,
          jobRootDir: producerJobRoot,
        });
        if (!handoff) throw new Error("expected producer handoff");
        await writeFile(
          join(producerJobRoot, "project-producer.latest-result.json"),
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

        await writeFile(join(sourceWorkspacePath, "router.md"), "current\n");
        await git(sourceWorkspacePath, ["add", "router.md"]);
        await git(sourceWorkspacePath, [
          "commit",
          "-m",
          "docs: advance canonical",
        ]);
        const canonicalSha = await revision(sourceWorkspacePath);
        await git(sourceWorkspacePath, ["push", "origin", "HEAD:main"]);
        await git(sourceWorkspacePath, [
          "update-ref",
          "refs/remotes/origin/main",
          producerBase,
        ]);

        if (executionMode === "bounded") {
          const fakeRunnerPath = join(root, "fake-operation-runner.mjs");
          await writeFile(
            fakeRunnerPath,
            `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
const file = process.argv[process.argv.indexOf("--operation-file") + 1];
const operation = JSON.parse(await readFile(file, "utf8"));
const now = new Date().toISOString();
operation.status = "completed";
operation.runningAt = now;
operation.completedAt = now;
operation.updatedAt = now;
operation.result = { ok: true, mode: "fake_verifier_operation" };
await writeFile(file, JSON.stringify(operation, null, 2) + "\\n");
`,
          );
          await chmod(fakeRunnerPath, 0o755);
          process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_OPERATION_CLI_PATH =
            fakeRunnerPath;
        }

        await Promise.all([
          server.connect(serverTransport),
          client.connect(clientTransport),
        ]);
        await createProducerJob({
          client,
          root,
          registryRootDir,
          producerJobRoot,
          producerWorkspacePath,
        });
        await createControllerJob({
          client,
          root,
          registryRootDir,
          controllerJobRoot,
          sourceWorkspacePath,
        });
        await writeRejectedProducerLedger({
          root,
          producerWorkspacePath,
        });

        if (executionMode === "sync") {
          await expect(
            prepareVerifier({
              client,
              root,
              registryRootDir,
              sourceWorkspacePath,
              verifierWorkspacePath,
              producerBase,
              canonicalSha,
              patchSha256: handoff.manifest.artifacts.patch.sha256,
              executionMode,
              jobId: "project-denied-verifier",
              baseBranch: "blocked/main",
            }),
          ).rejects.toThrow(/project_control_denied:remote_denied/);
        }

        let remediation: Record<string, unknown> | undefined;
        let remediationRetry: Record<string, unknown> | undefined;
        if (executionMode === "sync") {
          await git(sourceWorkspacePath, [
            "update-ref",
            "refs/remotes/origin/main",
            canonicalSha,
          ]);
          remediation = await prepareRemediation({
            client,
            root,
            registryRootDir,
            sourceWorkspacePath,
            remediationWorkspacePath,
            producerBase,
            canonicalSha,
            patchSha256: handoff.manifest.artifacts.patch.sha256,
          });
          remediationRetry = await prepareRemediation({
            client,
            root,
            registryRootDir,
            sourceWorkspacePath,
            remediationWorkspacePath,
            producerBase,
            canonicalSha,
            patchSha256: handoff.manifest.artifacts.patch.sha256,
          });
          await git(sourceWorkspacePath, [
            "update-ref",
            "refs/remotes/origin/main",
            producerBase,
          ]);
        }

        await git(sourceWorkspacePath, ["reset", "--hard", producerBase]);
        await git(sourceWorkspacePath, [
          "update-ref",
          "refs/remotes/origin/main",
          producerBase,
        ]);

        const result = await prepareVerifier({
          client,
          root,
          registryRootDir,
          sourceWorkspacePath,
          verifierWorkspacePath,
          producerBase,
          canonicalSha,
          patchSha256: handoff.manifest.artifacts.patch.sha256,
          executionMode,
          expectedSourceCommit: canonicalSha,
        });

        expect(result).toMatchObject({
          ok: true,
          mode: "project_control_prepare_verifier",
        });
        if (executionMode === "sync") {
          expect(result).toMatchObject({
            worktree: { status: "applied" },
            startSkipped: true,
            canonicalRemoteHead: { oid: canonicalSha },
          });
          expect(remediation).toMatchObject({
            ok: true,
            mode: "project_control_refill_worker",
            workerRole: "producer",
            worktree: { status: "applied" },
            startSkipped: true,
          });
          expect(remediationRetry).toMatchObject({
            ok: true,
            mode: "project_control_refill_worker",
            worktree: { status: "noop" },
            startSkipped: true,
          });
          expect(await revision(remediationWorkspacePath)).toBe(canonicalSha);
          expect(await stagedPatchSha256(remediationWorkspacePath)).toBe(
            handoff.manifest.artifacts.patch.sha256,
          );
          expect(
            await gitStdout(remediationWorkspacePath, [
              "diff",
              "--name-only",
              "--",
            ]),
          ).toBe("");
          expect(
            await gitStdout(remediationWorkspacePath, [
              "ls-files",
              "--others",
              "--exclude-standard",
            ]),
          ).toBe("");
          const remediationManifest = await readCodexGoalJob({
            registryRootDir,
            jobId: "project-remediation",
          });
          await expect(
            assertProjectPreStartAdmissionLaunchBinding({
              manifest: remediationManifest,
              scope: projectScope({
                root,
                registryRootDir,
                sourceWorkspacePath,
              }),
              workspaceMode: "admitted_input_patch",
              expectedInputPatchArtifactSha256:
                handoff.manifest.artifacts.patch.sha256,
            }),
          ).resolves.toBeUndefined();
          expect(await revision(verifierWorkspacePath)).toBe(canonicalSha);
          const verifierManifest = parseCodexGoalJobManifest(
            JSON.parse(
              await readFile(
                codexGoalJobManifestPath({
                  registryRootDir,
                  jobId: "project-verifier",
                }),
                "utf8",
              ),
            ),
          );
          const scope = projectScope({
            root,
            registryRootDir,
            sourceWorkspacePath,
          });
          await expect(
            assertProjectPreStartAdmissionLaunchBinding({
              manifest: verifierManifest,
              scope,
              workspaceMode: "admitted_input_patch",
            }),
          ).resolves.toBeUndefined();
          await authorizeProjectPreStartAdmissionLaunch({
            manifest: verifierManifest,
            scope,
            workspaceMode: "admitted_input_patch",
          });

          const preexistingPatchPath = join(
            verifierManifest.jobRootDir,
            "preexisting-producer.patch",
          );
          await writeFile(
            preexistingPatchPath,
            await readFile(handoff.manifest.artifacts.patch.path),
          );
          const unrelatedPatchPath = join(
            verifierManifest.jobRootDir,
            "unrelated.patch",
          );
          const unrelatedPatch = "unrelated immutable input\n";
          await writeFile(unrelatedPatchPath, unrelatedPatch);
          const terminalArgs = {
            registryRootDir,
            controllerJobId: "project-controller",
            jobId: "project-verifier",
            terminalAttemptId: "verifier-account-unavailable",
            failureCategory: "infrastructure",
            failureCode: "account_reservation_unavailable",
            confirmFailedNoOutput: true,
          };
          await expect(
            callToolJson(client, "codex_goal_project_record_failed_no_output", {
              ...terminalArgs,
              preexistingWorkspacePatchPath: unrelatedPatchPath,
              preexistingWorkspacePatchSha256: createHash("sha256")
                .update(unrelatedPatch)
                .digest("hex"),
              confirmPreexistingWorkspacePatch: true,
            }),
          ).resolves.toMatchObject({
            ok: false,
            error:
              "project_control_pre_start_launch_binding_mismatch:input_patch_artifact",
          });
          await expect(
            callToolJson(client, "codex_goal_project_record_failed_no_output", {
              ...terminalArgs,
              preexistingWorkspacePatchPath: preexistingPatchPath,
              preexistingWorkspacePatchSha256:
                handoff.manifest.artifacts.patch.sha256,
            }),
          ).resolves.toMatchObject({
            ok: false,
            reason: "confirm_preexisting_workspace_patch_required",
          });
          const verifierLogPath =
            verifierManifest.logPath ??
            join(verifierManifest.jobRootDir, `${verifierManifest.taskId}.log`);
          await writeFile(verifierLogPath, "worker launch evidence\n");
          await expect(
            callToolJson(client, "codex_goal_project_record_failed_no_output", {
              ...terminalArgs,
              preexistingWorkspacePatchPath: preexistingPatchPath,
              preexistingWorkspacePatchSha256:
                handoff.manifest.artifacts.patch.sha256,
              confirmPreexistingWorkspacePatch: true,
            }),
          ).resolves.toMatchObject({
            ok: false,
            error: "failed_no_output_worker_launch_artifacts_present",
          });
          const verifierResultPath =
            verifierManifest.outputPath ??
            join(
              verifierManifest.jobRootDir,
              `${verifierManifest.taskId}.latest-result.json`,
            );
          const strictFailedResult = {
            status: "failed",
            changedFiles: ["feature.txt"],
            evidence: ["provider failed before completing the verifier"],
            blockers: ["provider_failure"],
            nextAction: "recover",
            reason: "provider_failure",
          };
          await writeFile(
            verifierResultPath,
            `${JSON.stringify(strictFailedResult)}\n`,
          );
          await expect(
            callToolJson(client, "codex_goal_project_record_failed_no_output", {
              ...terminalArgs,
              preexistingWorkspacePatchPath: preexistingPatchPath,
              preexistingWorkspacePatchSha256:
                handoff.manifest.artifacts.patch.sha256,
              confirmPreexistingWorkspacePatch: true,
            }),
          ).resolves.toMatchObject({
            ok: false,
            error: "failed_no_output_runtime_authored_changes_present",
          });
          await rm(verifierResultPath);
          await writeFile(
            join(
              verifierManifest.jobRootDir,
              `${verifierManifest.taskId}.stop-event.json`,
            ),
            `${JSON.stringify({
              schemaVersion: 1,
              jobId: verifierManifest.jobId,
              taskId: verifierManifest.taskId,
              stoppedAt: new Date().toISOString(),
              forceStop: true,
            })}\n`,
          );
          const archivedPreexistingPatchPath = join(
            verifierManifest.jobRootDir,
            "archives",
            "project-verifier-failed-no-output-verifier-account-unavailable",
            "preexisting-workspace.patch",
          );
          await expect(
            callToolJson(client, "codex_goal_project_record_failed_no_output", {
              ...terminalArgs,
              preexistingWorkspacePatchPath: preexistingPatchPath,
              preexistingWorkspacePatchSha256:
                handoff.manifest.artifacts.patch.sha256,
              confirmPreexistingWorkspacePatch: true,
            }),
          ).resolves.toMatchObject({
            ok: true,
            decision: {
              status: "failed_no_output",
              output: { authoredChanges: false, workspaceDirty: false },
              preexistingWorkspacePatch: {
                path: archivedPreexistingPatchPath,
                sha256: handoff.manifest.artifacts.patch.sha256,
              },
            },
          });

          await writeFile(
            join(verifierWorkspacePath, "feature.txt"),
            "unstaged drift\n",
          );
          await expect(
            assertProjectPreStartAdmissionLaunchBinding({
              manifest: verifierManifest,
              scope,
              workspaceMode: "admitted_input_patch",
            }),
          ).rejects.toThrow(
            "project_control_pre_start_launch_binding_mismatch",
          );

          await writeFile(
            join(verifierWorkspacePath, "feature.txt"),
            "producer\n",
          );
          await writeFile(
            join(verifierWorkspacePath, "UNTRACKED.txt"),
            "untracked drift\n",
          );
          await expect(
            assertProjectPreStartAdmissionLaunchBinding({
              manifest: verifierManifest,
              scope,
              workspaceMode: "admitted_input_patch",
            }),
          ).rejects.toThrow(
            "project_control_pre_start_launch_binding_mismatch",
          );
        } else {
          expect(result).toMatchObject({
            executionMode: "bounded",
            operationId: expect.any(String),
            operation: {
              toolName: "codex_goal_project_prepare_verifier",
            },
          });
        }
      } finally {
        if (previousRunnerPath === undefined) {
          delete process.env
            .SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_OPERATION_CLI_PATH;
        } else {
          process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_OPERATION_CLI_PATH =
            previousRunnerPath;
        }
        await Promise.allSettled([client.close(), server.close()]);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("continues the same prepared verifier with the admitted immutable patch", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "verifier-capacity-continuation-"),
    );
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "controller");
    const producerJobRoot = join(root, "worker-jobs", "producer");
    const sourceWorkspacePath = join(root, "workspaces", "canonical");
    const producerWorkspacePath = join(root, "worktrees", "producer");
    const verifierWorkspacePath = join(root, "worktrees", "verifier");
    const remotePath = join(root, "remote.git");
    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await git(root, ["init", "--bare", remotePath]);
      await Promise.all([
        mkdir(sourceWorkspacePath, { recursive: true }),
        mkdir(join(root, "control", "consumed-output-ledger", "items"), {
          recursive: true,
        }),
      ]);
      await gitInitRepository(sourceWorkspacePath);
      await Promise.all([
        writeFile(join(sourceWorkspacePath, "README.md"), "base\n"),
        writeFile(join(sourceWorkspacePath, "controller.md"), "controller\n"),
        writeFile(join(sourceWorkspacePath, "lane.md"), "lane\n"),
        writeFile(join(sourceWorkspacePath, "feature.txt"), "base\n"),
        mkdir(join(sourceWorkspacePath, "checks")),
      ]);
      await writeFile(join(sourceWorkspacePath, "checks", ".keep"), "");
      await git(sourceWorkspacePath, ["add", "."]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      const canonicalSha = await revision(sourceWorkspacePath);
      await git(sourceWorkspacePath, ["remote", "add", "origin", remotePath]);
      await git(sourceWorkspacePath, ["push", "-u", "origin", "HEAD:main"]);

      await git(root, ["clone", sourceWorkspacePath, producerWorkspacePath]);
      await git(producerWorkspacePath, [
        "config",
        "user.email",
        "test@example.com",
      ]);
      await git(producerWorkspacePath, ["config", "user.name", "Test User"]);
      await writeFile(join(producerWorkspacePath, "feature.txt"), "producer\n");
      await writeFile(join(producerWorkspacePath, "added.txt"), "added\n");
      const handoff = await materializeCodexGoalHandoffArtifacts({
        workerJobId: "project-producer",
        taskId: "project-producer",
        workspacePath: producerWorkspacePath,
        jobRootDir: producerJobRoot,
      });
      if (!handoff) throw new Error("expected producer handoff");
      await writeFile(
        join(producerJobRoot, "project-producer.latest-result.json"),
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

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await createProducerJob({
        client,
        root,
        registryRootDir,
        producerJobRoot,
        producerWorkspacePath,
      });
      const allowedAccountIds = ["account-c", "account-g"];
      await createControllerJob({
        client,
        root,
        registryRootDir,
        controllerJobRoot,
        sourceWorkspacePath,
        allowedAccountIds,
      });
      await prepareVerifier({
        client,
        root,
        registryRootDir,
        sourceWorkspacePath,
        verifierWorkspacePath,
        producerBase: canonicalSha,
        canonicalSha,
        patchSha256: handoff.manifest.artifacts.patch.sha256,
        executionMode: "sync",
        accounts: ["account-c"],
        ownedPaths: ["feature.txt", "added.txt"],
      });

      const verifierManifestPath = codexGoalJobManifestPath({
        registryRootDir,
        jobId: "project-verifier",
      });
      const initialVerifierManifest = await readCodexGoalJob({
        registryRootDir,
        jobId: "project-verifier",
      });
      const controller = await readCodexGoalJob({
        registryRootDir,
        jobId: "project-controller",
      });
      const scope = projectScope({
        root,
        registryRootDir,
        sourceWorkspacePath,
        allowedAccountIds,
      });
      await authorizeProjectPreStartAdmissionLaunch({
        manifest: initialVerifierManifest,
        scope,
        workspaceMode: "admitted_input_patch",
      });
      expect(await stagedPatchSha256(verifierWorkspacePath)).not.toBe(
        handoff.manifest.artifacts.patch.sha256,
      );
      const latestResultPath = join(
        initialVerifierManifest.jobRootDir,
        `${initialVerifierManifest.taskId}.latest-result.json`,
      );
      const accountUnavailableResult = `${JSON.stringify({
        status: "blocked",
        reason: "account_unavailable",
        changedFiles: [],
        evidence: ["safe_execution_status:waiting_capacity"],
        blockers: ["account_unavailable"],
        nextAction: "wait",
      })}\n`;
      await writeFile(latestResultPath, accountUnavailableResult);
      const journal = new InMemoryAttemptJournal();
      await recordUnavailableAttempt({
        journal,
        taskId: initialVerifierManifest.taskId,
        workspacePath: await realpath(initialVerifierManifest.workspacePath),
        accountId: "account-c",
      });

      const verifierManifest = initialVerifierManifest;

      const stagedPatchBefore = await stagedPatchSha256(verifierWorkspacePath);
      const manifestBefore = await readFile(verifierManifestPath, "utf8");
      const registryEntriesBefore = await directoryEntries(registryRootDir);
      const worktreesBefore = await gitStdout(sourceWorkspacePath, [
        "worktree",
        "list",
        "--porcelain",
      ]);
      let brokerCalls = 0;
      let reservedLaunch: CodexGoalLaunchInput | undefined;
      let startManifest = verifierManifest;
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
        listAccountStatuses: async (input) => {
          expect(input).toEqual({ authRootDir: join(root, "auth") });
          return allowedAccountIds.map((accountId) => ({
            name: accountId,
            authJsonPath: join(root, "auth", accountId, "auth.json"),
            status: "ready" as const,
            availability: "available" as const,
            schedulerEligible: true,
            recommendedAction: "none" as const,
            warnings: [],
            safeMessage: "ready",
          }));
        },
        dependencyBootstrap: async () => ({
          mode: "install",
          workspacePath: verifierWorkspacePath,
          nodeModulesPath: join(verifierWorkspacePath, "node_modules"),
          nodeModulesExists: true,
          binaryChecks: [],
          fingerprintInputs: [],
          status: "installed",
          warnings: [],
        }),
        codexProjectControlBroker: (input) => {
          brokerCalls += 1;
          if (!input.startLaunch || !input.startManifest) {
            throw new Error("expected_start_binding");
          }
          reservedLaunch = input.startLaunch;
          startManifest = input.startManifest;
          startAdmissionWorkspaceMode = input.startAdmissionWorkspaceMode;
          return {
            startWorker: async () => {
              await authorizeProjectPreStartAdmissionLaunch({
                manifest: input.startManifest!,
                scope,
                ...(input.startAdmissionWorkspaceMode
                  ? { workspaceMode: input.startAdmissionWorkspaceMode }
                  : {}),
              });
              return { status: "started" };
            },
          } as unknown as ProjectControlBroker;
        },
      };
      const startArgs = {
        registryRootDir,
        controllerJobId: controller.jobId,
        jobId: verifierManifest.jobId,
        continuationAccounts: ["account-g"],
        confirmStart: true,
      };
      await writeFile(
        latestResultPath,
        `${JSON.stringify({
          status: "blocked",
          reason: "quota_limited",
          changedFiles: [],
          evidence: ["safe_execution_status:waiting_capacity"],
          blockers: ["quota_limited"],
          nextAction: "wait",
        })}\n`,
      );
      await expect(
        projectControlStartStoredJobView(startArgs, deps),
      ).rejects.toThrow(
        "project_control_continuation_attempt_history_required",
      );
      expect(brokerCalls).toBe(0);
      const quotaAttemptAt = new Date("2026-07-19T00:00:00.000Z");
      await journal.appendAttempt({
        taskId: verifierManifest.taskId,
        attempt: {
          taskId: verifierManifest.taskId,
          attemptNumber: 2,
          provider: "codex",
          startedAt: quotaAttemptAt,
          finishedAt: quotaAttemptAt,
          status: "blocked",
          failureReason: "quota_limited",
          workspaceDirtyBefore: true,
          workspaceDirtyAfter: true,
          changedFiles: [],
        },
        now: quotaAttemptAt,
      });
      await journal.markPartial({
        taskId: verifierManifest.taskId,
        status: "waiting_capacity",
        reason: "quota_limited",
        now: quotaAttemptAt,
      });
      const started = await projectControlStartStoredJobView(startArgs, deps);

      expect(started).toMatchObject({
        ok: true,
        accountReservation: { accountId: "account-g" },
      });
      expect(brokerCalls).toBe(1);
      expect(startAdmissionWorkspaceMode).toBe(
        "admitted_input_patch_continuation",
      );
      expect(startManifest.jobId).toBe(verifierManifest.jobId);
      expect(startManifest.taskId).toBe(verifierManifest.taskId);
      expect(startManifest.workspacePath).toBe(verifierManifest.workspacePath);
      expect(reservedLaunch?.config.taskId).toBe(verifierManifest.taskId);
      expect(reservedLaunch?.config.workspacePath).toBe(
        await realpath(verifierManifest.workspacePath),
      );
      expect(reservedLaunch?.config.maxAccountCycles).toBe(3);
      expect(reservedLaunch?.config.accounts).toEqual([{
        name: "account-g",
        authJsonPath: join(root, "auth", "account-g", "auth.json"),
      }]);
      expect(await stagedPatchSha256(verifierWorkspacePath)).toBe(
        stagedPatchBefore,
      );
      expect(stagedPatchBefore).not.toBe(
        handoff.manifest.artifacts.patch.sha256,
      );
      expect(await readFile(verifierManifestPath, "utf8")).toBe(manifestBefore);
      expect(await directoryEntries(registryRootDir)).toEqual(
        registryEntriesBefore,
      );
      expect(
        await gitStdout(sourceWorkspacePath, [
          "worktree",
          "list",
          "--porcelain",
        ]),
      ).toBe(worktreesBefore);
      const receipt = JSON.parse(
        await readFile(
          verifierManifest.projectPreStartAdmission!.receiptPath,
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(receipt.launchAuthorizationCount).toBe(2);

      await writeFile(join(verifierWorkspacePath, "UNTRACKED.txt"), "drift\n");
      await expect(
        projectControlStartStoredJobView(startArgs, deps),
      ).rejects.toThrow("project_control_pre_start_launch_binding_mismatch");
      expect(brokerCalls).toBe(1);
      expect(await readFile(verifierManifestPath, "utf8")).toBe(manifestBefore);
      expect(await directoryEntries(registryRootDir)).toEqual(
        registryEntriesBefore,
      );
      expect(
        await gitStdout(sourceWorkspacePath, [
          "worktree",
          "list",
          "--porcelain",
        ]),
      ).toBe(worktreesBefore);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function createApprovedReviewedOutput(input: {
  readonly root: string;
  readonly sourceWorkspacePath: string;
  readonly reviewedRoot: string;
  readonly workerJobId: string;
  readonly changedFile: string;
  readonly content: string;
  readonly advanceBase?: boolean;
}) {
  const workspacePath = join(input.root, "worktrees", input.workerJobId);
  await git(input.root, ["clone", input.sourceWorkspacePath, workspacePath]);
  if (input.advanceBase) {
    await git(workspacePath, ["config", "user.email", "test@example.com"]);
    await git(workspacePath, ["config", "user.name", "Test User"]);
    await writeFile(join(workspacePath, ".different-base"), "different\n");
    await writeFile(join(workspacePath, input.changedFile), "base\n");
    await git(workspacePath, ["add", ".different-base", input.changedFile]);
    await git(workspacePath, ["commit", "-m", "test: different base"]);
  }
  await writeFile(join(workspacePath, input.changedFile), input.content);
  const patch = await gitStdout(workspacePath, [
    "diff",
    "--binary",
    "HEAD",
    "--",
  ]);
  const deps = localReviewedWorkerOutputDeps({ rootDir: input.reviewedRoot });
  const snapshot = await captureReviewedWorkerOutput(deps, {
    projectId: "project",
    controllerJobId: "project-controller",
    workerJobId: input.workerJobId,
    taskId: input.workerJobId,
    workspacePath,
    expectedPatchSha256: createHash("sha256").update(patch).digest("hex"),
    decision: ReviewDecisionStatus.Approved,
    reviewedBy: "project-controller",
    reason: "approved",
    approvedFiles: [input.changedFile],
    requiredChecks: [],
  });
  const markerContent = `approved:${input.workerJobId}`;
  await commitReviewedWorkerOutputReviewAttestation({
    store: deps.store,
    markerVerifier: {
      async verify() {
        return {
          markerSha256: createHash("sha256")
            .update(markerContent)
            .digest("hex"),
          markerContent,
        };
      },
    },
    snapshot,
    reviewMarkerPath: `/evidence/${input.workerJobId}.json`,
  });
  return snapshot;
}

async function createProducerJob(input: {
  readonly client: Client;
  readonly root: string;
  readonly registryRootDir: string;
  readonly producerJobRoot: string;
  readonly producerWorkspacePath: string;
}): Promise<void> {
  const result = await callToolJson(input.client, "codex_goal_create_job", {
    registryRootDir: input.registryRootDir,
    jobId: "project-producer",
    jobRootDir: input.producerJobRoot,
    authRootDir: join(input.root, "auth"),
    workspacePath: input.producerWorkspacePath,
    promptPath: join(input.producerJobRoot, "prompt.md"),
    taskId: "project-producer",
    accounts: ["account-a"],
    accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
    networkAccess: NetworkAccessMode.Restricted,
    projectAccessScope: {
      projectId: "project",
      workspaceRoots: [input.producerWorkspacePath],
      isolatedWorkspaceRoot: input.producerWorkspacePath,
      registryRoot: input.registryRootDir,
      authRoot: join(input.root, "auth"),
      allowedAccountIds: ["account-a"],
      deniedRoots: [join(input.root, "real-user-project")],
    },
  });
  if (result.ok !== true) throw new Error(JSON.stringify(result));
}

async function createControllerJob(input: {
  readonly client: Client;
  readonly root: string;
  readonly registryRootDir: string;
  readonly controllerJobRoot: string;
  readonly sourceWorkspacePath: string;
  readonly allowedAccountIds?: readonly string[];
}): Promise<void> {
  const result = await callToolJson(input.client, "codex_goal_create_job", {
    registryRootDir: input.registryRootDir,
    jobId: "project-controller",
    jobRootDir: input.controllerJobRoot,
    authRootDir: join(input.root, "auth"),
    workspacePath: input.sourceWorkspacePath,
    promptPath: join(input.controllerJobRoot, "prompt.md"),
    taskId: "project-controller",
    accounts: [input.allowedAccountIds?.[0] ?? "account-a"],
    accessBoundary: AccessBoundary.ProjectScopedControl,
    networkAccess: NetworkAccessMode.Restricted,
    projectAccessScope: projectScope(input),
  });
  if (result.ok !== true) throw new Error(JSON.stringify(result));
}

async function prepareVerifier(input: {
  readonly client: Client;
  readonly root: string;
  readonly registryRootDir: string;
  readonly sourceWorkspacePath: string;
  readonly verifierWorkspacePath: string;
  readonly producerBase: string;
  readonly canonicalSha: string;
  readonly patchSha256: string;
  readonly executionMode: "sync" | "bounded";
  readonly jobId?: string;
  readonly baseBranch?: string;
  readonly expectedSourceCommit?: string;
  readonly accounts?: readonly string[];
  readonly ownedPaths?: readonly string[];
}): Promise<Record<string, unknown>> {
  const jobId = input.jobId ?? "project-verifier";
  const response = await input.client.callTool({
    name: "codex_goal_project_prepare_verifier",
    arguments: {
      registryRootDir: input.registryRootDir,
      controllerJobId: "project-controller",
      producerJobId: "project-producer",
      jobId,
      taskId: jobId,
      sourceWorkspacePath: input.sourceWorkspacePath,
      baseBranch: input.baseBranch ?? "origin/main",
      ...(input.expectedSourceCommit
        ? { expectedSourceCommit: input.expectedSourceCommit }
        : {}),
      newBranch: "review/verifier",
      workspacePath: input.verifierWorkspacePath,
      promptBody: "Review immutable producer output.\n",
      accounts: input.accounts ?? ["account-a"],
      workerRole: "reviewer",
      preStartAdmission: {
        mode: "serial-builtin",
        contract: {
          kind: "worker-launch",
          format: 1,
          canonicalSha: input.canonicalSha,
          baseSha: input.producerBase,
          phaseStartSha: input.canonicalSha,
          packetRevision: "review-r1",
          controllerPacket: "controller.md",
          lanePacket: "lane.md",
          phaseId: "phase-01",
          laneId: "review",
          inputPatchHash: input.patchSha256,
          reviewKind: "review",
          ownedPaths: input.ownedPaths ?? ["feature.txt"],
          mandatoryDocs: ["README.md", "controller.md", "lane.md"],
          mandatoryScripts: [],
          mandatoryFixtures: [],
          requiredChecks: [{
            id: "focused",
            cwd: "checks",
            command: "cd .. && git diff --check",
          }],
          executionPolicy: {
            mode: "sandbox-only",
            sandboxRoot: input.verifierWorkspacePath,
            forbiddenRealProjects: [join(input.root, "real-user-project")],
          },
        },
      },
      confirmPreStartAdmission: true,
      startWorker: false,
      executionMode: input.executionMode,
      confirmRefill: true,
    },
  });
  const text = (
    response as { readonly content?: readonly { readonly text?: string }[] }
  ).content?.[0]?.text;
  if (!text?.startsWith("{")) throw new Error(text ?? "missing response");
  const result = JSON.parse(text) as Record<string, unknown>;
  if (result.ok !== true) throw new Error(JSON.stringify(result));
  return result;
}

async function prepareRemediation(input: {
  readonly client: Client;
  readonly root: string;
  readonly registryRootDir: string;
  readonly sourceWorkspacePath: string;
  readonly remediationWorkspacePath: string;
  readonly producerBase: string;
  readonly canonicalSha: string;
  readonly patchSha256: string;
}): Promise<Record<string, unknown>> {
  const response = await input.client.callTool({
    name: "codex_goal_project_refill_worker",
    arguments: {
      registryRootDir: input.registryRootDir,
      controllerJobId: "project-controller",
      producerJobId: "project-producer",
      jobId: "project-remediation",
      taskId: "project-remediation",
      sourceWorkspacePath: input.sourceWorkspacePath,
      baseBranch: "origin/main",
      newBranch: "review/remediation",
      workspacePath: input.remediationWorkspacePath,
      promptBody: "Remediate immutable rejected producer output.\n",
      accounts: ["account-a"],
      workerRole: "producer",
      preStartAdmission: {
        mode: "serial-builtin",
        contract: {
          kind: "worker-launch",
          format: 1,
          canonicalSha: input.canonicalSha,
          baseSha: input.producerBase,
          phaseStartSha: input.canonicalSha,
          packetRevision: "remediation-r1",
          controllerPacket: "controller.md",
          lanePacket: "lane.md",
          phaseId: "phase-01",
          laneId: "remediation",
          inputPatchHash: input.patchSha256,
          reviewKind: "implementation",
          ownedPaths: ["feature.txt"],
          mandatoryDocs: ["README.md", "controller.md", "lane.md"],
          mandatoryScripts: [],
          mandatoryFixtures: [],
          requiredChecks: [
            {
              id: "focused",
              cwd: "checks",
              command: "cd .. && git diff --check",
            },
          ],
          executionPolicy: {
            mode: "sandbox-only",
            sandboxRoot: input.remediationWorkspacePath,
            forbiddenRealProjects: [join(input.root, "real-user-project")],
          },
        },
      },
      confirmPreStartAdmission: true,
      startWorker: false,
      executionMode: "sync",
      confirmRefill: true,
    },
  });
  const text = (
    response as { readonly content?: readonly { readonly text?: string }[] }
  ).content?.[0]?.text;
  if (!text?.startsWith("{")) throw new Error(text ?? "missing response");
  const result = JSON.parse(text) as Record<string, unknown>;
  if (result.ok !== true) throw new Error(JSON.stringify(result));
  return result;
}

async function revision(workspacePath: string): Promise<string> {
  return (await gitStdout(workspacePath, ["rev-parse", "HEAD"])).trim();
}

async function stagedPatchSha256(workspacePath: string): Promise<string> {
  const patch = await gitStdout(workspacePath, [
    "diff",
    "--cached",
    "--binary",
    "--no-ext-diff",
  ]);
  return createHash("sha256").update(patch).digest("hex");
}
