import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
export const codexGoalJobManifestSchemaVersion = 1;
export function defaultCodexGoalJobRegistryRoot() {
    return join(homedir(), ".cache", "subscription-runtime", "codex-goal-jobs");
}
export function defaultCodexGoalJobRoot(jobId) {
    assertJobId(jobId);
    return join(homedir(), ".cache", "subscription-runtime", jobId);
}
export function resolveCodexGoalJobRegistryRoot(input = {}) {
    return resolvePath(input.cwd ?? process.cwd(), input.registryRootDir ?? defaultCodexGoalJobRegistryRoot());
}
export function codexGoalJobManifestPath(input) {
    assertJobId(input.jobId);
    return join(input.registryRootDir, input.jobId, "job.json");
}
export async function listCodexGoalJobs(input = {}) {
    const registryRootDir = resolveCodexGoalJobRegistryRoot(input);
    let entries;
    try {
        entries = await readdir(registryRootDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const summaries = await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
        try {
            const manifest = await readCodexGoalJob({
                registryRootDir,
                jobId: entry.name,
            });
            return summarizeCodexGoalJob(manifest, registryRootDir);
        }
        catch {
            return null;
        }
    }));
    return summaries
        .filter((summary) => summary !== null)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
export async function readCodexGoalJob(input) {
    const registryRootDir = resolveCodexGoalJobRegistryRoot(input);
    const path = codexGoalJobManifestPath({ registryRootDir, jobId: input.jobId });
    return parseCodexGoalJobManifest(JSON.parse(await readFile(path, "utf8")));
}
export async function createCodexGoalJob(input) {
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
export async function updateCodexGoalJob(input) {
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
    await writeFile(codexGoalJobManifestPath({ registryRootDir, jobId: input.jobId }), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return manifest;
}
export function codexGoalJobToArgs(manifest) {
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
        permissionMode: manifest.permissionMode,
        allowDuplicateAccountIdentities: manifest.allowDuplicateAccountIdentities,
        requireGitWorkspace: manifest.requireGitWorkspace,
        prewarmOnStart: manifest.prewarmOnStart,
        tmuxSession: manifest.tmuxSession,
        cwd: manifest.cwd,
        logPath: manifest.logPath,
        outputFormat: manifest.outputFormat,
    };
}
export function summarizeCodexGoalJob(manifest, registryRootDir) {
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
export function parseCodexGoalJobManifest(value) {
    if (!isRecord(value))
        throw new Error("codex_goal_job_manifest_invalid");
    if (value.schemaVersion !== codexGoalJobManifestSchemaVersion) {
        throw new Error("codex_goal_job_manifest_version_unsupported");
    }
    const jobId = requiredString(value.jobId, "jobId");
    assertJobId(jobId);
    const accounts = readStringArray(value.accounts, "accounts");
    if (accounts.length === 0)
        throw new Error("codex_goal_job_accounts_required");
    const manifest = {
        schemaVersion: codexGoalJobManifestSchemaVersion,
        jobId,
        createdAt: requiredIsoDate(value.createdAt, "createdAt"),
        updatedAt: requiredIsoDate(value.updatedAt, "updatedAt"),
        ...(optionalString(value.description) === undefined
            ? {}
            : { description: optionalString(value.description) }),
        ...(value.tags === undefined ? {} : { tags: readStringArray(value.tags, "tags") }),
        jobRootDir: requiredString(value.jobRootDir, "jobRootDir"),
        ...(optionalString(value.authRootDir) === undefined
            ? {}
            : { authRootDir: optionalString(value.authRootDir) }),
        ...(optionalString(value.stateRootDir) === undefined
            ? {}
            : { stateRootDir: optionalString(value.stateRootDir) }),
        workspacePath: requiredString(value.workspacePath, "workspacePath"),
        promptPath: requiredString(value.promptPath, "promptPath"),
        taskId: requiredString(value.taskId, "taskId"),
        accounts,
        ...(optionalString(value.outputPath) === undefined
            ? {}
            : { outputPath: optionalString(value.outputPath) }),
        ...(optionalString(value.progressPath) === undefined
            ? {}
            : { progressPath: optionalString(value.progressPath) }),
        ...optionalPositiveIntegerProperty(value.progressHeartbeatMs, "progressHeartbeatMs"),
        ...(optionalString(value.codexBinaryPath) === undefined
            ? {}
            : { codexBinaryPath: optionalString(value.codexBinaryPath) }),
        ...(optionalString(value.model) === undefined
            ? {}
            : { model: optionalString(value.model) }),
        ...(optionalString(value.reasoningEffort) === undefined
            ? {}
            : {
                reasoningEffort: optionalString(value.reasoningEffort),
            }),
        ...(optionalString(value.serviceTier) === undefined
            ? {}
            : {
                serviceTier: optionalString(value.serviceTier),
            }),
        ...(optionalString(value.executionEngine) === undefined
            ? {}
            : {
                executionEngine: optionalString(value.executionEngine),
            }),
        ...optionalPositiveIntegerProperty(value.taskTimeoutMs, "taskTimeoutMs"),
        ...optionalPositiveIntegerProperty(value.staleLockMs, "staleLockMs"),
        ...optionalPositiveIntegerProperty(value.maxAccountCycles, "maxAccountCycles"),
        ...(optionalString(value.permissionMode) === undefined
            ? {}
            : {
                permissionMode: optionalString(value.permissionMode),
            }),
        ...optionalBooleanProperty(value.allowDuplicateAccountIdentities, "allowDuplicateAccountIdentities"),
        ...optionalBooleanProperty(value.requireGitWorkspace, "requireGitWorkspace"),
        ...optionalBooleanProperty(value.prewarmOnStart, "prewarmOnStart"),
        ...(optionalString(value.tmuxSession) === undefined
            ? {}
            : { tmuxSession: optionalString(value.tmuxSession) }),
        ...(optionalString(value.cwd) === undefined
            ? {}
            : { cwd: optionalString(value.cwd) }),
        ...(optionalString(value.logPath) === undefined
            ? {}
            : { logPath: optionalString(value.logPath) }),
        ...(optionalString(value.outputFormat) === undefined
            ? {}
            : {
                outputFormat: optionalString(value.outputFormat),
            }),
    };
    return manifest;
}
function assertJobId(value) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) {
        throw new Error("codex_goal_job_id_invalid");
    }
}
function requiredString(value, field) {
    const text = optionalString(value);
    if (!text)
        throw new Error(`codex_goal_job_${field}_required`);
    return text;
}
function optionalString(value) {
    return typeof value === "string" && value.trim() ? value : undefined;
}
function requiredIsoDate(value, field) {
    const text = requiredString(value, field);
    if (!Number.isFinite(Date.parse(text))) {
        throw new Error(`codex_goal_job_${field}_invalid`);
    }
    return text;
}
function readStringArray(value, field) {
    if (!Array.isArray(value))
        throw new Error(`codex_goal_job_${field}_invalid`);
    return value.map((item) => requiredString(item, field));
}
function optionalPositiveIntegerProperty(value, key) {
    if (value === undefined)
        return {};
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new Error(`codex_goal_job_${key}_invalid`);
    }
    return { [key]: value };
}
function optionalBooleanProperty(value, key) {
    if (value === undefined)
        return {};
    if (typeof value !== "boolean") {
        throw new Error(`codex_goal_job_${key}_invalid`);
    }
    return { [key]: value };
}
function resolvePath(cwd, value) {
    const expanded = value.startsWith("~/")
        ? join(homedir(), value.slice(2))
        : value;
    return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=codex-goal-jobs.js.map