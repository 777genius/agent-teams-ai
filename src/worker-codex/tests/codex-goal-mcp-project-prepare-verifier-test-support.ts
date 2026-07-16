import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type InMemoryAttemptJournal,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";

export function projectScope(input: {
  readonly root: string;
  readonly registryRootDir: string;
  readonly sourceWorkspacePath: string;
  readonly allowedAccountIds?: readonly string[];
}): ProjectAccessScope {
  return {
    projectId: "project",
    workspaceRoots: [input.sourceWorkspacePath],
    worktreeRoots: [join(input.root, "worktrees")],
    registryRoot: input.registryRootDir,
    consumedOutputLedgerRoots: [
      join(input.root, "control", "consumed-output-ledger"),
    ],
    authRoot: join(input.root, "auth"),
    jobIdPrefixes: ["project-"],
    tmuxSessionPrefixes: ["project-"],
    allowedBranches: ["main", "origin/main", "review/*"],
    allowedGitRemotes: ["origin"],
    allowedAccountIds: input.allowedAccountIds ?? ["account-a"],
    deniedRoots: [join(input.root, "real-user-project")],
    preStartAdmission: { required: true, mode: "serial-builtin" },
  };
}

export async function writeRejectedProducerLedger(input: {
  readonly root: string;
  readonly producerWorkspacePath: string;
}): Promise<void> {
  const ledgerRoot = join(input.root, "control", "consumed-output-ledger");
  const backupRoot = join(input.root, "control", "producer-rejection-backup");
  await mkdir(join(ledgerRoot, "items"), { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  const statusPath = join(backupRoot, "status.txt");
  const patchPath = join(backupRoot, "tracked.patch");
  const numstatPath = join(backupRoot, "numstat.txt");
  await writeFile(statusPath, " M feature.txt\n");
  await writeFile(patchPath, "diff --git a/feature.txt b/feature.txt\n");
  await writeFile(numstatPath, "1\t1\tfeature.txt\n");
  await writeFile(
    join(ledgerRoot, "items", "project-producer.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      jobId: "project-producer",
      status: "rejected",
      closedAt: "2026-07-15T00:00:00.000Z",
      note: "Rejected producer output retained for bounded remediation.",
      backup: {
        workspace: input.producerWorkspacePath,
        statusPath,
        patchPath,
        numstatPath,
      },
    }, null, 2)}\n`,
  );
}

export async function directoryEntries(path: string): Promise<readonly string[]> {
  return (await readdir(path)).sort();
}

export async function recordUnavailableAttempt(input: {
  readonly journal: InMemoryAttemptJournal;
  readonly taskId: string;
  readonly workspacePath: string;
  readonly accountId: string;
}): Promise<void> {
  const now = new Date("2026-07-14T00:00:00.000Z");
  await input.journal.startTask({
    taskId: input.taskId,
    workspaceRunId: "verifier-workspace-run",
    workspacePath: input.workspacePath,
    effectMode: "workspace_patch",
    provider: "codex",
    now,
  });
  await input.journal.appendAttempt({
    taskId: input.taskId,
    attempt: {
      taskId: input.taskId,
      attemptNumber: 1,
      accountId: input.accountId,
      provider: "codex",
      startedAt: now,
      finishedAt: now,
      status: "blocked",
      failureReason: "account_unavailable",
      workspaceDirtyBefore: true,
      workspaceDirtyAfter: true,
      changedFiles: [],
    },
    now,
  });
  await input.journal.markPartial({
    taskId: input.taskId,
    status: "waiting_capacity",
    reason: "account_unavailable",
    now,
  });
}
