import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
export async function projectIntegrationPushApprovedCommitWithConsumedLedger(input) {
    const controller = await input.loadController(input.args);
    const response = await input.pushApprovedCommitHandler(input.args);
    const payload = callToolResultJson(response);
    if (payload?.ok !== true)
        return response;
    const attempt = isRecord(payload.attempt) ? payload.attempt : undefined;
    if (!attempt)
        return response;
    const consumedOutputLedger = await recordConsumedOutputAfterPush(controller, attempt);
    if (!consumedOutputLedger)
        return response;
    return mcpJson({
        ...payload,
        consumedOutputLedger,
    });
}
function callToolResultJson(result) {
    if (isRecord(result.structuredContent)) {
        return result.structuredContent;
    }
    return undefined;
}
async function recordConsumedOutputAfterPush(controller, attempt) {
    const ledgerRoot = controller.scope.consumedOutputLedgerRoots?.[0];
    const commitSha = attempt.pushAttempt?.commitSha ?? attempt.commitCandidate?.commitSha;
    if (!ledgerRoot || !commitSha)
        return undefined;
    const archiveRoot = join(dirname(controller.registryRootDir), "archives");
    const archivePath = join(archiveRoot, `${safeArchiveName(attempt.workerOutput.workerJobId)}-integrated-${commitSha.slice(0, 8)}-${timestampForPath()}`);
    await mkdir(archivePath, { recursive: true });
    const statusPath = join(archivePath, "git-status.txt");
    const patchPath = join(archivePath, "tracked.diff");
    const numstatPath = join(archivePath, "tracked.numstat");
    await writeFile(statusPath, await safeGitOutput(attempt.workerOutput.workspacePath, [
        "status",
        "--short",
    ]));
    await writeFile(patchPath, await safeGitOutput(attempt.workerOutput.workspacePath, [
        "diff",
        "--",
        ...attempt.workerOutput.changedFiles,
    ]));
    await writeFile(numstatPath, await safeGitOutput(attempt.workerOutput.workspacePath, [
        "diff",
        "--numstat",
        "--",
        ...attempt.workerOutput.changedFiles,
    ]));
    const closedAt = new Date().toISOString();
    const ledgerPath = join(ledgerRoot, "items", `${safeArchiveName(attempt.workerOutput.workerJobId)}.json`);
    const note = `Integrated reviewed worker output via project lifecycle attempt ${attempt.attemptId}.`;
    const record = {
        schemaVersion: 1,
        jobId: attempt.workerOutput.workerJobId,
        status: "integrated",
        closedAt,
        consumedAt: closedAt,
        integratedCommitSha: commitSha,
        commitSha,
        commit: commitSha,
        archivePath,
        note,
        backup: {
            workspace: attempt.workerOutput.workspacePath,
            statusPath,
            patchPath,
            numstatPath,
        },
        notes: [{
                status: "integrated",
                text: note,
                commit: commitSha,
            }],
    };
    await mkdir(dirname(ledgerPath), { recursive: true });
    await writeJsonAtomic(ledgerPath, record);
    return {
        ledgerPath,
        archivePath,
        status: "integrated",
        commitSha,
    };
}
async function safeGitOutput(cwd, args) {
    try {
        const result = await execFileAsync("git", args, {
            cwd,
            maxBuffer: 10 * 1024 * 1024,
            timeout: 60_000,
        });
        return result.stdout;
    }
    catch (error) {
        return `git ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}\n`;
    }
}
async function writeJsonAtomic(path, value) {
    const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
    await rename(tmpPath, path);
}
function safeArchiveName(value) {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function timestampForPath() {
    return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
function mcpJson(value) {
    return {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
    };
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
//# sourceMappingURL=codex-goal-mcp-project-integration-ledger.js.map