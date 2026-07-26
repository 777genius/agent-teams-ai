import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  AccessBoundary,
  NetworkAccessMode,
} from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalJob } from "../codex-goal-jobs";
import {
  codexProjectControlBroker,
  loadJobLaunch,
  loadProjectControlController,
} from "../codex-goal-mcp-project-control-deps";
import { projectControlPruneWorkspaceDependenciesView } from "../codex-goal-mcp-project-control-workspace-maintenance";
import {
  git,
  gitInitRepository,
  gitStdout,
  readProjectControlAudit,
} from "./codex-goal-mcp-test-support";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("project workspace dependency maintenance", () => {
  it("previews, removes only node_modules and replays idempotently", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.workerWorkspace, "node_modules", "package"), {
      recursive: true,
    });
    await writeFile(
      join(fixture.workerWorkspace, "node_modules", "package", "index.js"),
      "module.exports = true;\n",
    );
    const statusBefore = await gitStdout(fixture.workerWorkspace, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);

    const preview = await projectControlPruneWorkspaceDependenciesView(
      fixture.args,
      deps(),
    );
    expect(preview).toMatchObject({
      ok: false,
      reason: "confirm_prune_required",
      requiredOverride: "confirmPrune",
      preview: {
        jobId: fixture.workerJobId,
        workspacePath: fixture.workerWorkspace,
        dependencyRootExists: true,
        terminalStatus: "integrated",
        workerAlive: false,
        sharedWorkspaceJobIds: [],
      },
      operation: { status: "noop" },
    });
    const applied = await projectControlPruneWorkspaceDependenciesView(
      { ...fixture.args, confirmPrune: true },
      deps(),
    );
    expect(applied).toMatchObject({
      ok: true,
      removed: true,
      idempotentReplay: false,
      operation: { status: "applied" },
    });
    await expect(
      readFile(
        join(fixture.workerWorkspace, "node_modules", "package", "index.js"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      gitStdout(fixture.workerWorkspace, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
    ).resolves.toBe(statusBefore);

    const replay = await projectControlPruneWorkspaceDependenciesView(
      { ...fixture.args, confirmPrune: true },
      deps(),
    );
    expect(replay).toMatchObject({
      ok: true,
      removed: false,
      idempotentReplay: true,
      operation: { status: "noop" },
    });
    const audit = await readProjectControlAudit(
      fixture.controllerJobRoot,
      fixture.controllerJobId,
    );
    expect(audit).toHaveLength(3);
    expect(
      audit.every(
        (event) =>
          (event.decision as { readonly operation?: string }).operation ===
          "prune_workspace_dependencies",
      ),
    ).toBe(true);
  });

  it("denies tracked roots and shared workspaces", async () => {
    const tracked = await createFixture();
    await mkdir(join(tracked.workerWorkspace, "node_modules"), {
      recursive: true,
    });
    await writeFile(
      join(tracked.workerWorkspace, "node_modules", "tracked.js"),
      "tracked\n",
    );
    await git(tracked.workerWorkspace, [
      "add",
      "-f",
      "node_modules/tracked.js",
    ]);
    await git(tracked.workerWorkspace, [
      "commit",
      "-m",
      "test: track dependency",
    ]);
    await expect(
      projectControlPruneWorkspaceDependenciesView(
        { ...tracked.args, confirmPrune: true },
        deps(),
      ),
    ).rejects.toThrow("project_control_prune_tracked_dependency_root_denied");

    const shared = await createFixture();
    await mkdir(join(shared.workerWorkspace, "node_modules"), {
      recursive: true,
    });
    await createStoredJob(
      shared,
      "project-worker-shared-v1",
      shared.workerWorkspace,
    );
    await expect(
      projectControlPruneWorkspaceDependenciesView(
        { ...shared.args, confirmPrune: true },
        deps(),
      ),
    ).rejects.toThrow(
      "project_control_prune_shared_workspace_job:project-worker-shared-v1",
    );
  });

  it("requires exact terminal binding and rechecks liveness under lock", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.workerWorkspace, "node_modules"), {
      recursive: true,
    });
    await expect(
      projectControlPruneWorkspaceDependenciesView(
        {
          ...fixture.args,
          expectedWorkspacePath: join(fixture.root, "wrong-workspace"),
          confirmPrune: true,
        },
        deps(),
      ),
    ).rejects.toThrow("project_control_prune_expected_workspace_mismatch");
    await expect(
      projectControlPruneWorkspaceDependenciesView(
        { ...fixture.args, confirmPrune: true },
        {
          ...deps(),
          collectStatus: async () => ({
            tmuxAlive: true,
            recommendedAction: "wait_for_worker",
            warnings: [],
          }),
        },
      ),
    ).rejects.toThrow("project_control_prune_worker_still_alive");

    await writeTerminalLedger(fixture, "archived");
    await expect(
      projectControlPruneWorkspaceDependenciesView(
        { ...fixture.args, confirmPrune: true },
        deps(),
      ),
    ).rejects.toThrow("project_control_prune_terminal_output_required");
  });
});

function deps() {
  return {
    loadProjectControlController,
    loadJobLaunch,
    codexProjectControlBroker,
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture() {
  const root = await realpath(
    await mkdtemp(
      join(tmpdir(), "subscription-runtime-workspace-maintenance-"),
    ),
  );
  roots.push(root);
  const registryRootDir = join(root, "worker-jobs", "registry");
  const ledgerRoot = join(root, "control", "consumed-output-ledger");
  const worktreeRoot = join(root, "worktrees");
  const controllerWorkspace = join(root, "repo");
  const controllerJobId = "project-controller-v1";
  const workerJobId = "project-worker-v1";
  const workerWorkspace = join(worktreeRoot, workerJobId);
  const controllerJobRoot = join(root, "worker-jobs", controllerJobId);
  await createCleanWorkspace(controllerWorkspace);
  await createCleanWorkspace(workerWorkspace);
  const seed = {
    root,
    registryRootDir,
    controllerWorkspace,
    ledgerRoot,
    worktreeRoot,
  };
  await createStoredJob(seed, controllerJobId, controllerWorkspace, true);
  await createStoredJob(seed, workerJobId, workerWorkspace);
  const fixture = {
    root,
    registryRootDir,
    ledgerRoot,
    worktreeRoot,
    controllerWorkspace,
    controllerJobId,
    controllerJobRoot,
    workerJobId,
    workerWorkspace,
    args: {
      registryRootDir,
      controllerJobId,
      jobId: workerJobId,
      expectedWorkspacePath: workerWorkspace,
    },
  };
  await writeTerminalLedger(fixture, "integrated");
  return fixture;
}

async function createCleanWorkspace(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await gitInitRepository(path);
  await writeFile(join(path, ".gitignore"), "node_modules/\n");
  await writeFile(join(path, "README.md"), "base\n");
  await git(path, ["add", ".gitignore", "README.md"]);
  await git(path, ["commit", "-m", "test: base"]);
}

type StoredJobSeed = {
  readonly root: string;
  readonly registryRootDir: string;
  readonly controllerWorkspace: string;
  readonly ledgerRoot: string;
  readonly worktreeRoot: string;
};

async function createStoredJob(
  input: StoredJobSeed,
  jobId: string,
  workspacePath: string,
  controller = false,
): Promise<void> {
  const jobRootDir = join(input.root, "worker-jobs", jobId);
  await mkdir(jobRootDir, { recursive: true });
  await writeFile(join(jobRootDir, "prompt.md"), "test prompt\n");
  await createCodexGoalJob({
    registryRootDir: input.registryRootDir,
    manifest: {
      jobId,
      jobRootDir,
      workspacePath,
      promptPath: join(jobRootDir, "prompt.md"),
      taskId: jobId,
      accounts: ["account-a"],
      networkAccess: NetworkAccessMode.Restricted,
      ...(controller
        ? {
            accessBoundary: AccessBoundary.ProjectScopedControl,
            projectAccessScope: {
              projectId: "project",
              readRoots: [],
              workspaceRoots: [input.controllerWorkspace],
              worktreeRoots: [input.worktreeRoot],
              registryRoot: input.registryRootDir,
              consumedOutputLedgerRoots: [input.ledgerRoot],
              jobIdPrefixes: ["project-"],
              tmuxSessionPrefixes: ["project-"],
              allowedAccountIds: ["account-a"],
            },
          }
        : {}),
    },
  });
}

async function writeTerminalLedger(
  fixture: Pick<
    Fixture,
    "root" | "ledgerRoot" | "workerJobId" | "workerWorkspace"
  >,
  status: "integrated" | "archived",
): Promise<void> {
  const evidenceRoot = join(
    fixture.root,
    "worker-jobs",
    "archives",
    `${fixture.workerJobId}-${status}`,
  );
  await mkdir(join(fixture.ledgerRoot, "items"), { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  const statusPath = join(evidenceRoot, "git-status.txt");
  const patchPath = join(evidenceRoot, "worker-output.patch");
  await writeFile(statusPath, "");
  await writeFile(patchPath, "reviewed output\n");
  await writeFile(
    join(fixture.ledgerRoot, "items", `${fixture.workerJobId}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        jobId: fixture.workerJobId,
        status,
        closedAt: "2026-07-26T00:00:00.000Z",
        ...(status === "integrated" ? { commitSha: "a".repeat(40) } : {}),
        note: "Terminal worker output consumed.",
        backup: {
          workspace: fixture.workerWorkspace,
          statusPath,
          patchPath,
        },
      },
      null,
      2,
    )}\n`,
  );
}
