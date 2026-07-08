import { readdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readCodexGoalJob, } from "./codex-goal-jobs.js";
import { noopOperationResult, } from "./codex-goal-mcp-project-broker.js";
import { execGit, execGitStdout } from "./codex-goal-mcp-project-git.js";
import { nodeErrorCode } from "./codex-goal-mcp-project-utils.js";
import { projectControlRealPathOutsideWorkspaceScope } from "./codex-goal-mcp-project-scope.js";
async function pathExists(path) {
    try {
        await stat(path);
        return true;
    }
    catch (error) {
        if (nodeErrorCode(error) === "ENOENT")
            return false;
        throw error;
    }
}
export async function readTextFileIfExists(path) {
    try {
        return await readFile(path, "utf8");
    }
    catch (error) {
        if (nodeErrorCode(error) === "ENOENT")
            return null;
        throw error;
    }
}
export async function assertReadablePrompt(input) {
    const body = await readTextFileIfExists(input.promptPath);
    if (body === null || body.trim().length === 0) {
        throw new Error("project_control_prompt_missing_before_start");
    }
    if (input.expectedBody !== undefined && body !== input.expectedBody) {
        throw new Error("project_control_prompt_mismatch");
    }
    return {
        promptPath: input.promptPath,
        bytes: Buffer.byteLength(body, "utf8"),
    };
}
export async function createOrReuseProjectWorktree(input) {
    if (await pathExists(input.createWorktreeInput.path)) {
        await assertReusableProjectWorktree(input.createWorktreeInput.path);
        return {
            result: noopOperationResult(input.createWorktreeInput.path, "existing clean git worktree reused for idempotent refill"),
            created: false,
        };
    }
    try {
        return {
            result: await input.broker.createWorktree(input.createWorktreeInput),
            created: true,
        };
    }
    catch (error) {
        if (await pathExists(input.createWorktreeInput.path)) {
            await assertReusableProjectWorktree(input.createWorktreeInput.path);
            return {
                result: noopOperationResult(input.createWorktreeInput.path, "existing clean git worktree reused after create race"),
                created: false,
            };
        }
        throw error;
    }
}
async function assertReusableProjectWorktree(path) {
    try {
        await execGitStdout(["-C", path, "rev-parse", "--show-toplevel"]);
        const status = await execGitStdout(["-C", path, "status", "--porcelain"]);
        if (status.trim().length > 0) {
            throw new Error("project_control_existing_worktree_dirty");
        }
    }
    catch (error) {
        if (error instanceof Error &&
            error.message === "project_control_existing_worktree_dirty") {
            throw error;
        }
        throw new Error("project_control_existing_worktree_invalid");
    }
}
export async function rollbackProjectRefillPartial(input) {
    const rolledBack = [];
    if (input.promptWritten) {
        await rm(input.promptPath, { force: true });
        rolledBack.push("prompt");
    }
    await removeEmptyDir(dirname(input.promptPath));
    await removeEmptyDir(join(input.registryRootDir, input.jobId));
    if (input.worktreeCreated) {
        try {
            await execGit([
                "-C",
                input.sourceWorkspacePath,
                "worktree",
                "remove",
                "--force",
                input.workspacePath,
            ]);
            rolledBack.push("worktree");
        }
        catch {
            rolledBack.push("worktree-remove-failed");
        }
    }
    return rolledBack;
}
export async function createOrReuseProjectJob(input) {
    const existing = await readExistingCodexGoalJob({
        registryRootDir: input.registryRootDir,
        jobId: input.manifest.jobId,
    });
    if (existing) {
        await assertExistingRefillJobMatches({
            existing,
            expected: input.manifest,
            promptBody: input.promptBody,
        });
        return {
            result: noopOperationResult(existing.jobId, "existing job manifest and prompt reused for idempotent refill"),
            manifest: existing,
        };
    }
    const realWorkspacePath = await projectControlRealPathOutsideWorkspaceScope(input.manifest.workspacePath, input.scope);
    const result = await input.broker.createJob({
        jobId: input.manifest.jobId,
        registryRoot: input.registryRootDir,
        workspacePath: input.manifest.workspacePath,
        ...(realWorkspacePath ? { realWorkspacePath } : {}),
        ...(input.manifest.tmuxSession
            ? { tmuxSession: input.manifest.tmuxSession }
            : {}),
        accounts: input.manifest.accounts,
        ...(input.workerRole ? { workerRole: input.workerRole } : {}),
        ...(input.manifest.tags ? { tags: input.manifest.tags } : {}),
    });
    return {
        result,
        manifest: await readCodexGoalJob({
            registryRootDir: input.registryRootDir,
            jobId: input.manifest.jobId,
        }),
    };
}
async function readExistingCodexGoalJob(input) {
    try {
        return await readCodexGoalJob(input);
    }
    catch (error) {
        if (nodeErrorCode(error) === "ENOENT")
            return null;
        throw error;
    }
}
async function assertExistingRefillJobMatches(input) {
    const mismatches = projectRefillJobMismatches(input.existing, input.expected);
    if (mismatches.length > 0) {
        throw new Error(`project_control_existing_job_mismatch:${mismatches.join(",")}`);
    }
    await assertReadablePrompt({
        promptPath: input.expected.promptPath,
        expectedBody: input.promptBody,
    });
}
function projectRefillJobMismatches(existing, expected) {
    const mismatches = [];
    const checks = [
        ["jobRootDir", existing.jobRootDir, expected.jobRootDir],
        ["workspacePath", existing.workspacePath, expected.workspacePath],
        ["promptPath", existing.promptPath, expected.promptPath],
        ["taskId", existing.taskId, expected.taskId],
        ["tmuxSession", existing.tmuxSession, expected.tmuxSession],
        ["accessBoundary", existing.accessBoundary, expected.accessBoundary],
        ["networkAccess", existing.networkAccess, expected.networkAccess],
        [
            "allowDangerFullAccess",
            existing.allowDangerFullAccess,
            expected.allowDangerFullAccess,
        ],
        ["accounts", existing.accounts, expected.accounts],
        ["projectAccessScope", existing.projectAccessScope, expected.projectAccessScope],
    ];
    for (const [field, left, right] of checks) {
        if (JSON.stringify(left ?? null) !== JSON.stringify(right ?? null)) {
            mismatches.push(field);
        }
    }
    return mismatches;
}
async function removeEmptyDir(path) {
    try {
        const entries = await readdir(path);
        if (entries.length === 0)
            await rmdir(path);
    }
    catch (error) {
        if (nodeErrorCode(error) !== "ENOENT" && nodeErrorCode(error) !== "ENOTDIR") {
            throw error;
        }
    }
}
//# sourceMappingURL=codex-goal-mcp-project-refill.js.map