import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { CodexGoalRunConfig } from "./codex-goal-runner";
import type { CodexGoalOutputFormat } from "./codex-goal-ops";
import {
  assertCodexGoalProviderSandboxModeAllowed,
  optionalCodexGoalEditMode,
  optionalCodexGoalProviderSandboxMode,
} from "./codex-goal-control-modes";

export const codexGoalJobManifestSchemaVersion = 1;

export type CodexGoalJobManifest = {
  readonly schemaVersion: typeof codexGoalJobManifestSchemaVersion;
  readonly jobId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly jobRootDir: string;
  readonly authRootDir?: string;
  readonly stateRootDir?: string;
  readonly workspacePath: string;
  readonly promptPath: string;
  readonly taskId: string;
  readonly accounts: readonly string[];
  readonly outputPath?: string;
  readonly progressPath?: string;
  readonly progressHeartbeatMs?: number;
  readonly codexBinaryPath?: string;
  readonly model?: string;
  readonly reasoningEffort?: CodexGoalRunConfig["reasoningEffort"];
  readonly serviceTier?: CodexGoalRunConfig["serviceTier"];
  readonly executionEngine?: CodexGoalRunConfig["executionEngine"];
  readonly taskTimeoutMs?: number;
  readonly staleLockMs?: number;
  readonly maxAccountCycles?: number;
  readonly editMode?: CodexGoalRunConfig["editMode"];
  readonly providerSandboxMode?: CodexGoalRunConfig["providerSandboxMode"];
  readonly allowDuplicateAccountIdentities?: boolean;
  readonly requireGitWorkspace?: boolean;
  readonly prewarmOnStart?: boolean;
  readonly workerReportMode?: CodexGoalRunConfig["workerReportMode"];
  readonly tmuxSession?: string;
  readonly cwd?: string;
  readonly logPath?: string;
  readonly outputFormat?: CodexGoalOutputFormat;
};

export type CodexGoalJobManifestInput = Omit<
  CodexGoalJobManifest,
  "schemaVersion" | "createdAt" | "updatedAt"
> & {
  readonly createdAt?: string;
  readonly updatedAt?: string;
};

export type CodexGoalJobManifestPatch = Partial<
  Omit<CodexGoalJobManifestInput, "jobId" | "createdAt">
>;

export type CodexGoalJobSummary = {
  readonly jobId: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly taskId: string;
  readonly workspacePath: string;
  readonly promptPath: string;
  readonly tmuxSession?: string;
  readonly accountNames: readonly string[];
  readonly updatedAt: string;
  readonly manifestPath: string;
};

export type CodexGoalJobRegistryInput = {
  readonly registryRootDir?: string;
  readonly cwd?: string;
};

export function defaultCodexGoalJobRegistryRoot(): string {
  return join(homedir(), ".cache", "subscription-runtime", "codex-goal-jobs");
}

export function defaultCodexGoalJobRoot(jobId: string): string {
  assertJobId(jobId);
  return join(homedir(), ".cache", "subscription-runtime", jobId);
}

export function resolveCodexGoalJobRegistryRoot(
  input: CodexGoalJobRegistryInput = {},
): string {
  return resolvePath(
    input.cwd ?? process.cwd(),
    input.registryRootDir ?? defaultCodexGoalJobRegistryRoot(),
  );
}

export function codexGoalJobManifestPath(input: {
  readonly registryRootDir: string;
  readonly jobId: string;
}): string {
  assertJobId(input.jobId);
  return join(input.registryRootDir, input.jobId, "job.json");
}

export async function listCodexGoalJobs(
  input: CodexGoalJobRegistryInput = {},
): Promise<readonly CodexGoalJobSummary[]> {
  const registryRootDir = resolveCodexGoalJobRegistryRoot(input);
  let entries;
  try {
    entries = await readdir(registryRootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          const manifest = await readCodexGoalJob({
            registryRootDir,
            jobId: entry.name,
          });
          return summarizeCodexGoalJob(manifest, registryRootDir);
        } catch {
          return null;
        }
      }),
  );
  return summaries
    .filter((summary): summary is CodexGoalJobSummary => summary !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function readCodexGoalJob(input: {
  readonly registryRootDir?: string;
  readonly jobId: string;
  readonly cwd?: string;
}): Promise<CodexGoalJobManifest> {
  const registryRootDir = resolveCodexGoalJobRegistryRoot(input);
  const path = codexGoalJobManifestPath({ registryRootDir, jobId: input.jobId });
  return parseCodexGoalJobManifest(JSON.parse(await readFile(path, "utf8")));
}

export async function createCodexGoalJob(input: {
  readonly registryRootDir?: string;
  readonly manifest: CodexGoalJobManifestInput;
  readonly overwrite?: boolean;
  readonly cwd?: string;
  readonly now?: Date;
}): Promise<CodexGoalJobManifest> {
  const registryRootDir = resolveCodexGoalJobRegistryRoot(input);
  const now = (input.now ?? new Date()).toISOString();
  const manifest = parseCodexGoalJobManifest({
    ...input.manifest,
    schemaVersion: codexGoalJobManifestSchemaVersion,
    createdAt: input.manifest.createdAt ?? now,
    updatedAt: input.manifest.updatedAt ?? now,
  });
  const path = codexGoalJobManifestPath({
    registryRootDir,
    jobId: manifest.jobId,
  });
  await mkdir(join(registryRootDir, manifest.jobId), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: input.overwrite ? 0o600 : 0o600,
    flag: input.overwrite ? "w" : "wx",
  });
  return manifest;
}

export async function updateCodexGoalJob(input: {
  readonly registryRootDir?: string;
  readonly jobId: string;
  readonly patch: CodexGoalJobManifestPatch;
  readonly cwd?: string;
  readonly now?: Date;
}): Promise<CodexGoalJobManifest> {
  const registryRootDir = resolveCodexGoalJobRegistryRoot(input);
  const existing = await readCodexGoalJob({
    registryRootDir,
    jobId: input.jobId,
  });
  const manifest = parseCodexGoalJobManifest({
    ...existing,
    ...input.patch,
    jobId: existing.jobId,
    schemaVersion: codexGoalJobManifestSchemaVersion,
    createdAt: existing.createdAt,
    updatedAt: (input.now ?? new Date()).toISOString(),
  });
  await writeFile(
    codexGoalJobManifestPath({ registryRootDir, jobId: input.jobId }),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return manifest;
}

export function codexGoalJobToArgs(
  manifest: CodexGoalJobManifest,
): Readonly<Record<string, unknown>> {
  return {
    jobId: manifest.jobId,
    jobRootDir: manifest.jobRootDir,
    authRootDir: manifest.authRootDir,
    stateRootDir: manifest.stateRootDir,
    workspacePath: manifest.workspacePath,
    promptPath: manifest.promptPath,
    taskId: manifest.taskId,
    accounts: manifest.accounts,
    outputPath: manifest.outputPath,
    progressPath: manifest.progressPath,
    progressHeartbeatMs: manifest.progressHeartbeatMs,
    codexBinaryPath: manifest.codexBinaryPath,
    model: manifest.model,
    reasoningEffort: manifest.reasoningEffort,
    serviceTier: manifest.serviceTier,
    executionEngine: manifest.executionEngine,
    taskTimeoutMs: manifest.taskTimeoutMs,
    staleLockMs: manifest.staleLockMs,
    maxAccountCycles: manifest.maxAccountCycles,
    editMode: manifest.editMode,
    providerSandboxMode: manifest.providerSandboxMode,
    allowDuplicateAccountIdentities: manifest.allowDuplicateAccountIdentities,
    requireGitWorkspace: manifest.requireGitWorkspace,
    prewarmOnStart: manifest.prewarmOnStart,
    workerReportMode: manifest.workerReportMode,
    tmuxSession: manifest.tmuxSession,
    cwd: manifest.cwd,
    logPath: manifest.logPath,
    outputFormat: manifest.outputFormat,
  };
}

export function summarizeCodexGoalJob(
  manifest: CodexGoalJobManifest,
  registryRootDir: string,
): CodexGoalJobSummary {
  return {
    jobId: manifest.jobId,
    ...(manifest.description ? { description: manifest.description } : {}),
    tags: manifest.tags ?? [],
    taskId: manifest.taskId,
    workspacePath: manifest.workspacePath,
    promptPath: manifest.promptPath,
    ...(manifest.tmuxSession ? { tmuxSession: manifest.tmuxSession } : {}),
    accountNames: manifest.accounts,
    updatedAt: manifest.updatedAt,
    manifestPath: codexGoalJobManifestPath({
      registryRootDir,
      jobId: manifest.jobId,
    }),
  };
}

export function parseCodexGoalJobManifest(
  value: unknown,
): CodexGoalJobManifest {
  if (!isRecord(value)) throw new Error("codex_goal_job_manifest_invalid");
  if (value.schemaVersion !== codexGoalJobManifestSchemaVersion) {
    throw new Error("codex_goal_job_manifest_version_unsupported");
  }
  const jobId = requiredString(value.jobId, "jobId");
  assertJobId(jobId);
  const accounts = readStringArray(value.accounts, "accounts");
  if (accounts.length === 0) throw new Error("codex_goal_job_accounts_required");
  const editMode = optionalCodexGoalEditMode(
    optionalString(value.editMode) ?? optionalString(value.permissionMode),
    optionalString(value.editMode) === undefined &&
      optionalString(value.permissionMode) !== undefined
      ? "permissionMode"
      : "editMode",
  );
  const providerSandboxMode = optionalCodexGoalProviderSandboxMode(
    optionalString(value.providerSandboxMode),
    "providerSandboxMode",
  );
  assertCodexGoalProviderSandboxModeAllowed({
    editMode,
    providerSandboxMode,
    fieldName: "providerSandboxMode",
  });
  const manifest: CodexGoalJobManifest = {
    schemaVersion: codexGoalJobManifestSchemaVersion,
    jobId,
    createdAt: requiredIsoDate(value.createdAt, "createdAt"),
    updatedAt: requiredIsoDate(value.updatedAt, "updatedAt"),
    ...(optionalString(value.description) === undefined
      ? {}
      : { description: optionalString(value.description) as string }),
    ...(value.tags === undefined ? {} : { tags: readStringArray(value.tags, "tags") }),
    jobRootDir: requiredString(value.jobRootDir, "jobRootDir"),
    ...(optionalString(value.authRootDir) === undefined
      ? {}
      : { authRootDir: optionalString(value.authRootDir) as string }),
    ...(optionalString(value.stateRootDir) === undefined
      ? {}
      : { stateRootDir: optionalString(value.stateRootDir) as string }),
    workspacePath: requiredString(value.workspacePath, "workspacePath"),
    promptPath: requiredString(value.promptPath, "promptPath"),
    taskId: requiredString(value.taskId, "taskId"),
    accounts,
    ...(optionalString(value.outputPath) === undefined
      ? {}
      : { outputPath: optionalString(value.outputPath) as string }),
    ...(optionalString(value.progressPath) === undefined
      ? {}
      : { progressPath: optionalString(value.progressPath) as string }),
    ...optionalPositiveIntegerProperty(
      value.progressHeartbeatMs,
      "progressHeartbeatMs",
    ),
    ...(optionalString(value.codexBinaryPath) === undefined
      ? {}
      : { codexBinaryPath: optionalString(value.codexBinaryPath) as string }),
    ...(optionalString(value.model) === undefined
      ? {}
      : { model: optionalString(value.model) as string }),
    ...(optionalString(value.reasoningEffort) === undefined
      ? {}
      : {
          reasoningEffort: optionalString(value.reasoningEffort) as NonNullable<
            CodexGoalRunConfig["reasoningEffort"]
          >,
        }),
    ...(optionalString(value.serviceTier) === undefined
      ? {}
      : {
          serviceTier: optionalString(value.serviceTier) as NonNullable<
            CodexGoalRunConfig["serviceTier"]
          >,
        }),
    ...(optionalString(value.executionEngine) === undefined
      ? {}
      : {
          executionEngine: optionalString(value.executionEngine) as NonNullable<
            CodexGoalRunConfig["executionEngine"]
          >,
        }),
    ...optionalPositiveIntegerProperty(value.taskTimeoutMs, "taskTimeoutMs"),
    ...optionalPositiveIntegerProperty(value.staleLockMs, "staleLockMs"),
    ...optionalPositiveIntegerProperty(value.maxAccountCycles, "maxAccountCycles"),
    ...(editMode === undefined ? {} : { editMode }),
    ...(providerSandboxMode === undefined ? {} : { providerSandboxMode }),
    ...optionalBooleanProperty(
      value.allowDuplicateAccountIdentities,
      "allowDuplicateAccountIdentities",
    ),
    ...optionalBooleanProperty(value.requireGitWorkspace, "requireGitWorkspace"),
    ...optionalBooleanProperty(value.prewarmOnStart, "prewarmOnStart"),
    ...(optionalWorkerReportMode(value.workerReportMode) === undefined
      ? {}
      : {
          workerReportMode: optionalWorkerReportMode(
            value.workerReportMode,
          ) as NonNullable<CodexGoalRunConfig["workerReportMode"]>,
        }),
    ...(optionalString(value.tmuxSession) === undefined
      ? {}
      : { tmuxSession: optionalString(value.tmuxSession) as string }),
    ...(optionalString(value.cwd) === undefined
      ? {}
      : { cwd: optionalString(value.cwd) as string }),
    ...(optionalString(value.logPath) === undefined
      ? {}
      : { logPath: optionalString(value.logPath) as string }),
    ...(optionalString(value.outputFormat) === undefined
      ? {}
      : {
          outputFormat: optionalString(value.outputFormat) as CodexGoalOutputFormat,
        }),
  };
  return manifest;
}

function assertJobId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) {
    throw new Error("codex_goal_job_id_invalid");
  }
}

function requiredString(value: unknown, field: string): string {
  const text = optionalString(value);
  if (!text) throw new Error(`codex_goal_job_${field}_required`);
  return text;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredIsoDate(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`codex_goal_job_${field}_invalid`);
  }
  return text;
}

function readStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`codex_goal_job_${field}_invalid`);
  return value.map((item) => requiredString(item, field));
}

function optionalPositiveIntegerProperty(
  value: unknown,
  key: "taskTimeoutMs" | "staleLockMs" | "maxAccountCycles" | "progressHeartbeatMs",
): Partial<Pick<CodexGoalJobManifest, typeof key>> {
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`codex_goal_job_${key}_invalid`);
  }
  return { [key]: value } as Partial<Pick<CodexGoalJobManifest, typeof key>>;
}

function optionalBooleanProperty(
  value: unknown,
  key:
    | "allowDuplicateAccountIdentities"
    | "requireGitWorkspace"
    | "prewarmOnStart",
): Partial<Pick<CodexGoalJobManifest, typeof key>> {
  if (value === undefined) return {};
  if (typeof value !== "boolean") {
    throw new Error(`codex_goal_job_${key}_invalid`);
  }
  return { [key]: value } as Partial<Pick<CodexGoalJobManifest, typeof key>>;
}

function optionalWorkerReportMode(
  value: unknown,
): CodexGoalRunConfig["workerReportMode"] | undefined {
  if (value === undefined) return undefined;
  if (value === "runtime-only" || value === "structured-output") return value;
  throw new Error("codex_goal_job_workerReportMode_invalid");
}

function resolvePath(cwd: string, value: string): string {
  const expanded = value.startsWith("~/")
    ? join(homedir(), value.slice(2))
    : value;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
