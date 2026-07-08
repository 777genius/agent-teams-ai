import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
export async function buildCodexGoalWorkspaceConflicts(jobs) {
    const candidates = jobs.filter((job) => job.ok === true &&
        typeof job.jobId === "string" &&
        typeof job.workspacePath === "string" &&
        (job.workerAlive === true || job.safeToContinue === true));
    const keyed = await Promise.all(candidates.map(async (job) => ({
        job,
        workspaceKey: await workspaceConflictKey(String(job.workspacePath)),
    })));
    const groups = new Map();
    for (const item of keyed) {
        groups.set(item.workspaceKey, [...(groups.get(item.workspaceKey) ?? []), item]);
    }
    return [...groups.values()]
        .filter((group) => group.length > 1)
        .map((group) => ({
        workspacePath: group[0]?.job.workspacePath,
        workspaceKey: group[0]?.workspaceKey,
        jobIds: group.map((item) => item.job.jobId).filter((jobId) => typeof jobId === "string"),
        runningJobIds: group
            .filter((item) => item.job.workerAlive === true)
            .map((item) => item.job.jobId)
            .filter((jobId) => typeof jobId === "string"),
        safeToContinueJobIds: group
            .filter((item) => item.job.safeToContinue === true)
            .map((item) => item.job.jobId)
            .filter((jobId) => typeof jobId === "string"),
        reason: "multiple_potential_writers_share_workspace",
        safeMessage: "Multiple stored jobs can write to the same workspace. Continue only one writer after manual review.",
    }));
}
export async function workspaceConflictKey(workspacePath) {
    try {
        return await realpath(workspacePath);
    }
    catch {
        return resolve(process.cwd(), workspacePath);
    }
}
export function workspaceConflictJobIds(conflicts) {
    const ids = new Set();
    for (const conflict of conflicts) {
        const jobIds = Array.isArray(conflict.jobIds) ? conflict.jobIds : [];
        for (const jobId of jobIds) {
            if (typeof jobId === "string")
                ids.add(jobId);
        }
    }
    return ids;
}
export function applyWorkspaceConflictToOverviewJob(input) {
    const jobId = typeof input.job.jobId === "string" ? input.job.jobId : undefined;
    if (!jobId || !input.conflictJobIds.has(jobId))
        return input.job;
    const commands = isRecord(input.job.commands)
        ? omitJsonKey(input.job.commands, "continue")
        : input.job.commands;
    return {
        ...input.job,
        safeToContinue: false,
        blockedBySingleWriter: true,
        workspaceConflict: true,
        nextBestTool: "manual_review",
        nextBestReason: "single_writer_workspace_conflict",
        nextBestCommand: "manual_review_single_writer_workspace_conflict",
        ...(commands ? { commands } : {}),
    };
}
function omitJsonKey(value, key) {
    const copy = { ...value };
    delete copy[key];
    return copy;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=codex-goal-workspace-conflicts.js.map