import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ProjectAdmissionWorkerRole,
  ProjectDebtReason,
  ProjectOperation,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexProjectAdmissionGate,
  type CodexProjectAdmissionDeps,
} from "../application/project-control/codex-goal-project-admission";
import { prepareProjectPreStartAdmission } from "../application/project-control/codex-goal-project-pre-start-admission";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import {
  createBuiltinFixture,
  declarativeContract,
  sha256,
} from "./codex-goal-project-pre-start-admission-fixture";

const execFileAsync = promisify(execFile);

describe("pending admitted input patch admission", () => {
  it("reserves exact pending ownership while admitting a disjoint producer", async () => {
    const fixture = await pendingInputPatchFixture();
    try {
      const gate = codexProjectAdmissionGate({
        registryRootDir: fixture.registryRootDir,
        scope: fixture.scope,
        deps: fixture.deps,
      });
      const request = (ownedPaths: readonly string[]) => ({
        operation: ProjectOperation.StartWorker,
        jobId: "project-next",
        workerRole: ProjectAdmissionWorkerRole.Producer,
        workspacePath: join(fixture.root, "next"),
        ownedPaths,
      });

      await expect(
        gate.evaluate(request(["src/next/"])),
      ).resolves.toMatchObject({
        allowed: true,
        debt: [],
      });
      await expect(
        gate.evaluate(request(["src/pending/"])),
      ).resolves.toMatchObject({
        allowed: false,
        debt: [
          expect.objectContaining({
            reason: ProjectDebtReason.ActiveWriterConflict,
            subject: fixture.manifest.jobId,
            affectedPaths: expect.arrayContaining([
              "src/pending/",
              "src/pending/example.ts",
            ]),
            pathDisjointProducerEligible: true,
          }),
        ],
      });

      const ordinaryGate = codexProjectAdmissionGate({
        registryRootDir: fixture.registryRootDir,
        scope: fixture.scope,
        deps: {
          listJobs: fixture.deps.listJobs,
          buildOverviewItems: fixture.deps.buildOverviewItems,
        },
      });
      await expect(
        ordinaryGate.evaluate(request(["src/next/"])),
      ).resolves.toMatchObject({
        allowed: false,
        reason: "output_debt_present",
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rebuilds the snapshot before starting a bound pending patch", async () => {
    const fixture = await pendingInputPatchFixture();
    const liveWorkspace = join(fixture.root, "live-sibling");
    const request = {
      operation: ProjectOperation.StartWorker,
      jobId: fixture.manifest.jobId,
      workerRole: ProjectAdmissionWorkerRole.Producer,
      workspacePath: fixture.manifest.workspacePath,
    } as const;
    try {
      const boundGate = codexProjectAdmissionGate({
        registryRootDir: fixture.registryRootDir,
        scope: fixture.scope,
        deps: fixture.deps,
        admittedInputPatchTarget: {
          jobId: fixture.manifest.jobId,
          workspacePath: fixture.manifest.workspacePath,
        },
      });
      await expect(boundGate.evaluate(request)).resolves.toMatchObject({
        allowed: true,
        debt: [],
      });

      const liveSibling = {
        jobId: "project-live-sibling",
        tags: ["worker-role-producer"],
        taskId: "project-live-sibling",
        workspacePath: liveWorkspace,
        promptPath: join(fixture.root, "live-sibling.md"),
        accountNames: ["account-b"],
        updatedAt: fixture.manifest.updatedAt,
        manifestPath: join(fixture.root, "live-sibling.json"),
      };
      const guardedGate = codexProjectAdmissionGate({
        registryRootDir: fixture.registryRootDir,
        scope: fixture.scope,
        deps: {
          ...fixture.deps,
          listJobs: async () => [
            ...(await fixture.deps.listJobs()),
            liveSibling,
          ],
          buildOverviewItems: async () => [
            ...(await fixture.deps.buildOverviewItems()),
            {
              ok: true,
              jobId: liveSibling.jobId,
              workspacePath: liveWorkspace,
              workspaceDirty: false,
              workerAlive: true,
              activeWriterRisk: "active_worker",
              activeWriterRiskReasons: ["active_worker"],
            },
          ],
        },
        admittedInputPatchTarget: {
          jobId: fixture.manifest.jobId,
          workspacePath: fixture.manifest.workspacePath,
        },
      });
      await expect(guardedGate.evaluate(request)).resolves.toMatchObject({
        allowed: false,
        reason: "output_debt_present",
        debt: expect.arrayContaining([
          expect.objectContaining({ subject: liveSibling.jobId }),
        ]),
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function pendingInputPatchFixture() {
  const fixture = await createBuiltinFixture();
  await mkdir(join(fixture.workspacePath, "src", "pending"), {
    recursive: true,
  });
  await writeFile(
    join(fixture.workspacePath, "src", "pending", "example.ts"),
    "export const pending = true;\n",
  );
  await execFileAsync("git", ["add", "src/pending/example.ts"], {
    cwd: fixture.workspacePath,
  });
  const stagedPatch = (
    await execFileAsync("git", ["diff", "--cached", "--binary", "HEAD", "--"], {
      cwd: fixture.workspacePath,
    })
  ).stdout;
  const artifactSha256 = sha256(Buffer.from("broker-reviewed immutable input"));
  const plan = fixture.plan({
    contract: {
      ...declarativeContract(fixture.contract),
      inputPatchHash: artifactSha256,
      reviewKind: "remediation",
      ownedPaths: ["src/pending/"],
    },
    state: undefined,
  });
  const manifest: CodexGoalJobManifest = {
    ...fixture.storedManifest,
    tags: ["project-control-refill", "worker-role-producer"],
    projectPreStartAdmission: plan.descriptor,
  };
  const scope: ProjectAccessScope = {
    ...fixture.scope,
    worktreeRoots: [fixture.workspacePath],
    jobIdPrefixes: ["project-"],
  };
  await prepareProjectPreStartAdmission({
    plan,
    manifest,
    scope,
    verifiedInputPatchArtifactSha256: artifactSha256,
    verifiedInputPatchStagedSha256: sha256(Buffer.from(stagedPatch)),
  });
  const summary = {
    jobId: manifest.jobId,
    tags: manifest.tags ?? [],
    taskId: manifest.taskId,
    workspacePath: manifest.workspacePath,
    promptPath: manifest.promptPath,
    accountNames: manifest.accounts,
    updatedAt: manifest.updatedAt,
    manifestPath: join(fixture.root, "manifest.json"),
  };
  const overview = {
    ok: true,
    jobId: manifest.jobId,
    tags: manifest.tags,
    workspacePath: manifest.workspacePath,
    workspaceDirty: true,
    workerAlive: false,
    activeWriterRisk: "dirty_workspace_without_worker",
    activeWriterRiskReasons: ["dirty_workspace_without_worker"],
    lifecycleMarkerTypes: [],
  };
  return {
    ...fixture,
    manifest,
    scope,
    registryRootDir: join(fixture.root, "registry"),
    deps: {
      listJobs: async () => [summary],
      buildOverviewItems: async () => [overview],
      readJob: async () => manifest,
    } satisfies CodexProjectAdmissionDeps,
  };
}
