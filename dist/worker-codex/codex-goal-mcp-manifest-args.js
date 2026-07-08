import { join } from "node:path";
import { defaultCodexGoalJobRoot, } from "./codex-goal-jobs.js";
import { optionalCodexGoalEditMode, optionalCodexGoalProviderSandboxMode, } from "./codex-goal-control-modes.js";
import { optionalCodexGoalAccessBoundary, optionalCodexGoalNetworkAccess, parseCodexGoalProjectAccessScope, } from "./codex-goal-access-plan.js";
import { defaultCodexGoalAuthRoot } from "./codex-goal-mcp-accounts.js";
import { CODEX_GOAL_MCP_DEFAULT_TIMEOUT_MS, goalControlModesFromRecord, } from "./codex-goal-mcp-launch-input.js";
import { accountNames, booleanValue, numberValue, putIfDefined, requiredRawString, requiredString, resolvePath, stringValue, tagValues, workerReportModeValue, } from "./codex-goal-mcp-values.js";
const defaultAuthRoot = defaultCodexGoalAuthRoot;
const defaultTimeoutMs = CODEX_GOAL_MCP_DEFAULT_TIMEOUT_MS;
export function jobManifestInputFromArgs(args) {
    const cwd = resolvePath(process.cwd(), args.cwd ?? process.cwd());
    const jobId = requiredRawString(args.jobId, "jobId");
    const jobRootDir = resolvePath(cwd, args.jobRootDir ?? defaultCodexGoalJobRoot(jobId));
    const controlModes = goalControlModesFromRecord(args);
    const accessBoundary = optionalCodexGoalAccessBoundary(args.accessBoundary);
    const projectAccessScope = parseCodexGoalProjectAccessScope(args.projectAccessScope);
    const networkAccess = optionalCodexGoalNetworkAccess(args.networkAccess);
    return {
        jobId,
        ...(stringValue(args.description) ? { description: stringValue(args.description) } : {}),
        ...(tagValues(args.tags).length ? { tags: tagValues(args.tags) } : {}),
        jobRootDir,
        authRootDir: resolvePath(cwd, args.authRootDir ?? defaultAuthRoot),
        ...(args.stateRootDir ? { stateRootDir: resolvePath(cwd, args.stateRootDir) } : {}),
        workspacePath: requiredString(args.workspacePath, "workspacePath", cwd),
        promptPath: resolvePath(cwd, args.promptPath ?? join(jobRootDir, "prompt.md")),
        ...(stringValue(args.codexGoalObjective)
            ? { codexGoalObjective: stringValue(args.codexGoalObjective) }
            : {}),
        taskId: args.taskId ?? jobId,
        accounts: accountNames(args.accounts),
        ...(args.outputPath ? { outputPath: resolvePath(cwd, args.outputPath) } : {}),
        ...(args.progressPath ? { progressPath: resolvePath(cwd, args.progressPath) } : {}),
        progressHeartbeatMs: args.progressHeartbeatMs ?? 60_000,
        ...(args.codexBinaryPath ? { codexBinaryPath: args.codexBinaryPath } : {}),
        model: args.model ?? "gpt-5.5",
        reasoningEffort: args.reasoningEffort ?? "high",
        serviceTier: args.serviceTier ?? "default",
        executionEngine: args.executionEngine ?? "app-server-goal",
        taskTimeoutMs: args.taskTimeoutMs ?? defaultTimeoutMs,
        ...(args.appServerStartupTimeoutMs
            ? { appServerStartupTimeoutMs: args.appServerStartupTimeoutMs }
            : {}),
        ...(args.staleLockMs ? { staleLockMs: args.staleLockMs } : {}),
        maxAccountCycles: args.maxAccountCycles ?? 5,
        ...controlModes,
        ...(accessBoundary === undefined ? {} : { accessBoundary }),
        ...(projectAccessScope === undefined ? {} : { projectAccessScope }),
        ...(args.allowDangerFullAccess === undefined
            ? {}
            : { allowDangerFullAccess: args.allowDangerFullAccess }),
        ...(networkAccess === undefined ? {} : { networkAccess }),
        allowDuplicateAccountIdentities: args.allowDuplicateAccountIdentities ?? false,
        requireGitWorkspace: args.requireGitWorkspace ?? true,
        prewarmOnStart: args.prewarmOnStart ?? false,
        ...(args.workerReportMode ? { workerReportMode: args.workerReportMode } : {}),
        tmuxSession: args.tmuxSession ?? jobId,
        ...(args.cwd ? { cwd } : {}),
        ...(args.logPath ? { logPath: resolvePath(cwd, args.logPath) } : {}),
        outputFormat: args.outputFormat ?? "json",
    };
}
export function jobManifestPatchFromArgs(args) {
    const cwd = resolvePath(process.cwd(), args.cwd ?? process.cwd());
    const patch = {};
    putIfDefined(patch, "description", stringValue(args.description));
    const tags = tagValues(args.tags);
    if (args.tags !== undefined)
        patch.tags = tags;
    putIfDefined(patch, "jobRootDir", args.jobRootDir && resolvePath(cwd, args.jobRootDir));
    putIfDefined(patch, "authRootDir", args.authRootDir && resolvePath(cwd, args.authRootDir));
    putIfDefined(patch, "stateRootDir", args.stateRootDir && resolvePath(cwd, args.stateRootDir));
    putIfDefined(patch, "workspacePath", args.workspacePath && resolvePath(cwd, args.workspacePath));
    putIfDefined(patch, "promptPath", args.promptPath && resolvePath(cwd, args.promptPath));
    putIfDefined(patch, "codexGoalObjective", stringValue(args.codexGoalObjective));
    putIfDefined(patch, "taskId", stringValue(args.taskId));
    if (args.accounts !== undefined)
        patch.accounts = accountNames(args.accounts);
    putIfDefined(patch, "outputPath", args.outputPath && resolvePath(cwd, args.outputPath));
    putIfDefined(patch, "progressPath", args.progressPath && resolvePath(cwd, args.progressPath));
    putIfDefined(patch, "progressHeartbeatMs", numberValue(args.progressHeartbeatMs));
    putIfDefined(patch, "codexBinaryPath", stringValue(args.codexBinaryPath));
    putIfDefined(patch, "model", stringValue(args.model));
    putIfDefined(patch, "reasoningEffort", stringValue(args.reasoningEffort));
    putIfDefined(patch, "serviceTier", stringValue(args.serviceTier));
    putIfDefined(patch, "executionEngine", stringValue(args.executionEngine));
    putIfDefined(patch, "taskTimeoutMs", numberValue(args.taskTimeoutMs));
    putIfDefined(patch, "appServerStartupTimeoutMs", numberValue(args.appServerStartupTimeoutMs));
    putIfDefined(patch, "staleLockMs", numberValue(args.staleLockMs));
    putIfDefined(patch, "maxAccountCycles", numberValue(args.maxAccountCycles));
    putIfDefined(patch, "editMode", optionalCodexGoalEditMode(stringValue(args.editMode), "editMode"));
    putIfDefined(patch, "providerSandboxMode", optionalCodexGoalProviderSandboxMode(stringValue(args.providerSandboxMode), "providerSandboxMode"));
    putIfDefined(patch, "accessBoundary", optionalCodexGoalAccessBoundary(args.accessBoundary));
    putIfDefined(patch, "projectAccessScope", parseCodexGoalProjectAccessScope(args.projectAccessScope));
    putIfDefined(patch, "allowDangerFullAccess", booleanValue(args.allowDangerFullAccess));
    putIfDefined(patch, "networkAccess", optionalCodexGoalNetworkAccess(args.networkAccess));
    putIfDefined(patch, "allowDuplicateAccountIdentities", booleanValue(args.allowDuplicateAccountIdentities));
    putIfDefined(patch, "requireGitWorkspace", booleanValue(args.requireGitWorkspace));
    putIfDefined(patch, "prewarmOnStart", booleanValue(args.prewarmOnStart));
    putIfDefined(patch, "workerReportMode", workerReportModeValue(args.workerReportMode));
    putIfDefined(patch, "tmuxSession", stringValue(args.tmuxSession));
    putIfDefined(patch, "cwd", args.cwd && cwd);
    putIfDefined(patch, "logPath", args.logPath && resolvePath(cwd, args.logPath));
    putIfDefined(patch, "outputFormat", stringValue(args.outputFormat));
    return patch;
}
//# sourceMappingURL=codex-goal-mcp-manifest-args.js.map