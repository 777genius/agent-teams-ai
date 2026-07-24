import { appendFile, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  consumedOutputRecordFor,
  ProjectScopedRetention,
  type ProjectScopedRetentionAuditRecord,
  type ProjectScopedRetentionInspection,
  type ProjectScopedRetentionPorts,
} from "@vioxen/subscription-runtime/worker-core";
import {
  collectCodexGoalStatus,
  resolveCodexGoalWorkerLiveness,
} from "./codex-goal-ops";
import {
  readCodexGoalJob,
  type CodexGoalJobManifest,
} from "./codex-goal-jobs";
import {
  loadJobLaunch,
  loadProjectControlController,
  type LoadedProjectControlController,
} from "./codex-goal-mcp-project-control-deps";
import {
  projectControlAuditPath,
} from "./codex-goal-mcp-project-broker";
import { codexGoalStatusInputFromLaunch } from "./codex-goal-mcp-status-input";
import {
  readCodexGoalConsumedOutputLedgers,
} from "./application/project-control/codex-goal-consumed-output-ledger-io";
import {
  isGitAncestor,
  execGit,
  execGitStdout,
} from "./codex-goal-mcp-project-git";
import {
  projectControlOperationsRoot,
  ProjectControlOperationStatus,
  readProjectControlOperation,
} from "./project-control-operation-lifecycle";
import {
  projectControlWorkspaceLocks,
  withValidatedProjectWorkspaceLock,
} from "./codex-goal-project-workspace-lock";

export type ProjectRetentionMcpArgs = {
  readonly registryRootDir?: string;
  readonly cwd?: string;
  readonly controllerJobId?: string;
  readonly candidateIds?: readonly string[];
  readonly acceptedCanonicalCommit?: string;
  readonly maxCount?: number;
  readonly confirmCleanup?: boolean;
};

type JsonObject = Readonly<Record<string, unknown>>;

const CONSUMED_RETENTION_STATUSES = new Set([
  "integrated",
  "rejected",
  "duplicate",
  "superseded",
  "archived",
]);

export async function projectControlCleanupWorktreesView(
  args: ProjectRetentionMcpArgs,
): Promise<JsonObject> {
  const controller = await loadProjectControlController(args);
  const candidateIds = args.candidateIds ?? [];
  const acceptedCanonicalCommit =
    await resolveProjectRetentionCanonicalCommit({
      canonicalWorkspacePath: controller.controller.workspacePath,
      ...(args.acceptedCanonicalCommit
        ? { expectedCanonicalCommit: args.acceptedCanonicalCommit }
        : {}),
    });
  const retention = new ProjectScopedRetention(
    localProjectScopedRetentionPorts(controller),
  );
  const result = await retention.execute({
    controllerId: controller.controller.jobId,
    projectId: controller.scope.projectId,
    candidateIds,
    acceptedCanonicalCommit,
    ...(args.maxCount === undefined ? {} : { maxCount: args.maxCount }),
    confirm: args.confirmCleanup === true,
  });
  return {
    ok: result.results.every((item) =>
      item.decision === "eligible" ||
      item.decision === "removed" ||
      item.decision === "already_removed"
    ),
    auditPath: projectControlAuditPath(controller.controller),
    ...result,
    operation: "project_control_cleanup_worktrees",
  };
}

export function localProjectScopedRetentionPorts(
  controller: LoadedProjectControlController,
): ProjectScopedRetentionPorts {
  const locks = projectControlWorkspaceLocks(controller.registryRootDir);
  return {
    inspect: async (input) =>
      inspectLocalRetentionCandidate(controller, input),
    withExclusiveProjectRetentionLock: async <T>(input: {
      readonly controllerId: string;
      readonly projectId: string;
      readonly effect: () => Promise<T>;
    }): Promise<T> => {
      const canonicalProjectPath = await realpath(
        controller.controller.workspacePath,
      );
      const lock = await locks.acquire({
        workspacePath: canonicalProjectPath,
        owner:
          `project-retention:${input.controllerId}:${input.projectId}`,
      });
      try {
        return await input.effect();
      } finally {
        await locks.release(lock);
      }
    },
    withExclusiveWorkspaceLock: async <T>(input: {
      readonly controllerId: string;
      readonly candidateId: string;
      readonly workspacePath: string;
      readonly effect: () => Promise<T>;
    }): Promise<T> =>
      withValidatedProjectWorkspaceLock({
        locks,
        scope: controller.scope,
        requestedWorkspacePath: input.workspacePath,
        owner:
          `project-retention-workspace:${input.controllerId}:${input.candidateId}`,
        effect: input.effect,
      }),
    removeRegisteredWorktree: async (input) => {
      if (input.force !== false) {
        throw new Error("project_retention_force_remove_denied");
      }
      await execGit(projectRetentionWorktreeRemoveArgs({
        canonicalWorkspacePath: controller.controller.workspacePath,
        workspacePath: input.workspacePath,
      }));
    },
    appendAudit: async (record) =>
      appendProjectRetentionAudit(controller.controller, record),
  };
}

export function projectRetentionWorktreeRemoveArgs(input: {
  readonly canonicalWorkspacePath: string;
  readonly workspacePath: string;
}): readonly string[] {
  return [
    "-C",
    input.canonicalWorkspacePath,
    "worktree",
    "remove",
    input.workspacePath,
  ];
}

async function inspectLocalRetentionCandidate(
  controller: LoadedProjectControlController,
  input: {
    readonly controllerId: string;
    readonly projectId: string;
    readonly candidateId: string;
    readonly acceptedCanonicalCommit: string;
  },
): Promise<ProjectScopedRetentionInspection> {
  const manifest = await readCodexGoalJob({
    registryRootDir: controller.registryRootDir,
    jobId: input.candidateId,
  });
  const workspacePath = resolve(manifest.workspacePath);
  const ownedByController = retentionCandidateOwned({
    controller,
    manifest,
    controllerId: input.controllerId,
    projectId: input.projectId,
  });
  const childWorkspace = input.candidateId !== controller.controller.jobId &&
    insideAny(workspacePath, controller.scope.worktreeRoots ?? []);
  const jobRoot = insideOrEqual(workspacePath, manifest.jobRootDir) ||
    insideOrEqual(workspacePath, controller.controller.jobRootDir);
  const sharedDependencyCache = isSharedDependencyCachePath(workspacePath);
  const pathExists = await exists(workspacePath);
  const registered = await registeredWorktreePaths(
    controller.controller.workspacePath,
  );
  const exactRegisteredLinkedWorktree = registered.has(workspacePath);

  if (!pathExists && !exactRegisteredLinkedWorktree) {
    return {
      candidateId: input.candidateId,
      workspacePath,
      ownedByController,
      childWorkspace,
      jobRoot,
      sharedDependencyCache,
      workerAlive: undefined,
      unfinishedProjectOperation: undefined,
      terminalEvidence: undefined,
      repositoryIdentityMatches: undefined,
      exactRegisteredLinkedWorktree: false,
      pathExists: false,
      indexClean: undefined,
      worktreeClean: undefined,
      untrackedClean: undefined,
      unresolvedIndex: undefined,
      headAncestorOfAcceptedCommit: undefined,
    };
  }

  const loaded = await loadJobLaunch({
    registryRootDir: controller.registryRootDir,
    jobId: input.candidateId,
  });
  const status = await collectCodexGoalStatus(
    codexGoalStatusInputFromLaunch(loaded.launch),
  );
  const progressStale =
    status.progressHeartbeatAgeMs !== undefined &&
    status.progressHeartbeatAgeMs > 10 * 60_000;
  const workerAlive = resolveCodexGoalWorkerLiveness({
    status,
    progressStale,
  }).alive;
  const terminalEvidence = await localTerminalEvidence({
    controller,
    manifest,
  });
  const unfinishedProjectOperation = await hasUnfinishedProjectOperation(
    controller,
    input.candidateId,
  );
  const repositoryIdentityMatches = await sameRepositoryIdentity(
    controller.controller.workspacePath,
    workspacePath,
  );
  const gitState = await inspectGitState(
    controller.controller.workspacePath,
    workspacePath,
    input.acceptedCanonicalCommit,
  );
  return {
    candidateId: input.candidateId,
    workspacePath,
    ownedByController,
    childWorkspace,
    jobRoot,
    sharedDependencyCache,
    workerAlive,
    unfinishedProjectOperation,
    terminalEvidence,
    repositoryIdentityMatches,
    exactRegisteredLinkedWorktree,
    pathExists,
    ...gitState,
  };
}

function retentionCandidateOwned(input: {
  readonly controller: LoadedProjectControlController;
  readonly manifest: CodexGoalJobManifest;
  readonly controllerId: string;
  readonly projectId: string;
}): boolean {
  const candidateScope = input.manifest.projectAccessScope;
  const prefixes = input.controller.scope.jobIdPrefixes ?? [];
  return input.controller.controller.jobId === input.controllerId &&
    input.controller.scope.projectId === input.projectId &&
    input.manifest.jobId !== input.controllerId &&
    candidateScope?.projectId === input.projectId &&
    candidateScope?.registryRoot === input.controller.registryRootDir &&
    prefixes.some((prefix) => input.manifest.jobId.startsWith(prefix));
}

async function localTerminalEvidence(input: {
  readonly controller: LoadedProjectControlController;
  readonly manifest: CodexGoalJobManifest;
}): Promise<ProjectScopedRetentionInspection["terminalEvidence"]> {
  const ledger = await readCodexGoalConsumedOutputLedgers({
    roots: input.controller.scope.consumedOutputLedgerRoots ?? [],
  });
  const record = consumedOutputRecordFor({
    ledger,
    jobId: input.manifest.jobId,
    workspacePath: input.manifest.workspacePath,
  });
  if (!record?.valid) return undefined;
  return projectRetentionTerminalEvidenceForConsumedStatus(record.status);
}

export function projectRetentionTerminalEvidenceForConsumedStatus(
  status: string,
): ProjectScopedRetentionInspection["terminalEvidence"] {
  if (status === "failed_no_output") return "failed_no_output";
  if (status === "reviewed_no_change") return "reviewed";
  return CONSUMED_RETENTION_STATUSES.has(status)
    ? "consumed"
    : undefined;
}

async function hasUnfinishedProjectOperation(
  controller: LoadedProjectControlController,
  candidateId: string,
): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(
      projectControlOperationsRoot(controller.controller.jobRootDir),
      { withFileTypes: true },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const operation = await readProjectControlOperation(
      resolve(
        projectControlOperationsRoot(controller.controller.jobRootDir),
        entry.name,
        "operation.json",
      ),
    );
    if (
      operation.targetJobId === candidateId &&
      (operation.status === ProjectControlOperationStatus.Queued ||
        operation.status === ProjectControlOperationStatus.Running)
    ) {
      return true;
    }
  }
  return false;
}

async function inspectGitState(
  canonicalWorkspacePath: string,
  workspacePath: string,
  acceptedCanonicalCommit: string,
): Promise<Pick<
  ProjectScopedRetentionInspection,
  | "indexClean"
  | "worktreeClean"
  | "untrackedClean"
  | "unresolvedIndex"
  | "headAncestorOfAcceptedCommit"
>> {
  const authoritative = (
    await execGitStdout([
      "-C",
      canonicalWorkspacePath,
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ])
  ).trim().toLowerCase();
  if (authoritative !== acceptedCanonicalCommit.toLowerCase()) {
    throw new Error("project_retention_authoritative_commit_changed");
  }
  const accepted = (
    await execGitStdout([
      "-C",
      canonicalWorkspacePath,
      "rev-parse",
      "--verify",
      `${acceptedCanonicalCommit}^{commit}`,
    ])
  ).trim().toLowerCase();
  if (accepted !== acceptedCanonicalCommit.toLowerCase()) {
    throw new Error("project_retention_accepted_commit_mismatch");
  }
  const [cached, worktree, untracked, unresolved, head] = await Promise.all([
    execGitStdout(["-C", workspacePath, "diff", "--cached", "--name-only"]),
    execGitStdout(["-C", workspacePath, "diff", "--name-only"]),
    execGitStdout([
      "-C",
      workspacePath,
      "ls-files",
      "--others",
      "--exclude-standard",
    ]),
    execGitStdout(["-C", workspacePath, "diff", "--name-only", "--diff-filter=U"]),
    execGitStdout(["-C", workspacePath, "rev-parse", "--verify", "HEAD^{commit}"]),
  ]);
  return {
    indexClean: cached.trim().length === 0,
    worktreeClean: worktree.trim().length === 0,
    untrackedClean: untracked.trim().length === 0,
    unresolvedIndex: unresolved.trim().length > 0,
    headAncestorOfAcceptedCommit: await isGitAncestor({
      workspacePath: canonicalWorkspacePath,
      ancestor: head.trim(),
      descendant: accepted,
    }),
  };
}

export async function resolveProjectRetentionCanonicalCommit(input: {
  readonly canonicalWorkspacePath: string;
  readonly expectedCanonicalCommit?: string;
}): Promise<string> {
  const authoritative = (
    await execGitStdout([
      "-C",
      input.canonicalWorkspacePath,
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ])
  ).trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(authoritative)) {
    throw new Error("project_retention_authoritative_commit_invalid");
  }
  if (
    input.expectedCanonicalCommit &&
    input.expectedCanonicalCommit.toLowerCase() !== authoritative
  ) {
    throw new Error("project_retention_expected_canonical_commit_mismatch");
  }
  return authoritative;
}

async function sameRepositoryIdentity(
  canonicalWorkspacePath: string,
  workspacePath: string,
): Promise<boolean> {
  const [canonical, candidate] = await Promise.all([
    gitCommonDirectory(canonicalWorkspacePath),
    gitCommonDirectory(workspacePath),
  ]);
  return canonical === candidate;
}

async function gitCommonDirectory(workspacePath: string): Promise<string> {
  const raw = (
    await execGitStdout([
      "-C",
      workspacePath,
      "rev-parse",
      "--git-common-dir",
    ])
  ).trim();
  return realpath(isAbsolute(raw) ? raw : resolve(workspacePath, raw));
}

async function registeredWorktreePaths(
  canonicalWorkspacePath: string,
): Promise<ReadonlySet<string>> {
  const output = await execGitStdout([
    "-C",
    canonicalWorkspacePath,
    "worktree",
    "list",
    "--porcelain",
  ]);
  return new Set(
    output.split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => resolve(line.slice("worktree ".length))),
  );
}

async function appendProjectRetentionAudit(
  controller: CodexGoalJobManifest,
  record: ProjectScopedRetentionAuditRecord,
): Promise<void> {
  const path = projectControlAuditPath(controller);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function insideAny(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => insideOrEqual(path, root));
}

function insideOrEqual(path: string, root: string): boolean {
  const relation = relative(resolve(root), resolve(path));
  return relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." &&
      !isAbsolute(relation));
}

function isSharedDependencyCachePath(path: string): boolean {
  const normalized = path.split(sep);
  return normalized.includes("node_modules") ||
    normalized.includes(".pnpm-store") ||
    normalized.includes(".yarn-cache") ||
    normalized.includes(".npm");
}
