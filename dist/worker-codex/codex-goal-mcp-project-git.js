import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
export function assertSafeGitRefName(value, fieldName) {
    if (value.startsWith("-") ||
        value.includes("..") ||
        /[\s~^:?*\[\]\x00-\x1f\x7f]/.test(value) ||
        value.endsWith("/") ||
        value.endsWith(".") ||
        value.includes("//") ||
        value.length > 200) {
        throw new Error(`project_control_${fieldName}_invalid`);
    }
}
export function assertSafeGitRemoteName(value, fieldName) {
    if (value.startsWith("-") ||
        !/^[A-Za-z0-9._-]+$/.test(value) ||
        value.length > 100) {
        throw new Error(`project_control_${fieldName}_invalid`);
    }
}
export function assertSafeGitCommitSha(value) {
    if (!/^[0-9a-fA-F]{7,64}$/.test(value)) {
        throw new Error("project_control_commit_sha_invalid");
    }
}
export async function assertGitCurrentBranch(input) {
    const current = await execGitStdout([
        "-C",
        input.workspacePath,
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
    ]);
    if (current.trim() !== input.branch) {
        throw new Error("project_control_branch_mismatch");
    }
}
export async function execGit(args) {
    await execGitStdout(args);
}
export async function execGitStdout(args) {
    try {
        const { stdout } = await execFileAsync("git", [...args], {
            timeout: 120_000,
            maxBuffer: 1024 * 1024,
        });
        return stdout;
    }
    catch (error) {
        throw new Error(`project_control_git_failed:${gitOperationLabel(args)}:${gitErrorSummary(error)}`);
    }
}
function gitOperationLabel(args) {
    const command = args.find((arg) => arg === "worktree" ||
        arg === "cherry-pick" ||
        arg === "push" ||
        arg === "rev-parse");
    return command ?? "unknown";
}
function gitErrorSummary(error) {
    if (typeof error !== "object" || error === null)
        return "unknown";
    const candidate = error;
    const raw = typeof candidate.stderr === "string" && candidate.stderr.trim()
        ? candidate.stderr
        : typeof candidate.message === "string"
            ? candidate.message
            : typeof candidate.code === "string"
                ? candidate.code
                : "unknown";
    return raw
        .replace(/\s+/g, " ")
        .replace(/["'`]/g, "")
        .slice(0, 240);
}
//# sourceMappingURL=codex-goal-mcp-project-git.js.map