import { readFile } from "node:fs/promises";
import { tailCodexGoalLog } from "../codex-goal-ops.js";
export async function readRuntimeResultBrief(path) {
    try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        if (!isRecord(parsed))
            return {};
        const attempts = Array.isArray(parsed.attempts) ? parsed.attempts : [];
        const lastAttempt = lastRecord(attempts);
        const artifacts = runtimeResultArtifacts(parsed.artifacts);
        const patchPath = runtimeResultArtifactPath(artifacts, "patch");
        const summaryPath = runtimeResultArtifactPath(artifacts, "summary");
        const baseCommit = runtimeResultBaseCommit(parsed);
        return {
            ...(isRecord(lastAttempt) && typeof lastAttempt.accountId === "string"
                ? { currentAccount: lastAttempt.accountId }
                : {}),
            ...(typeof parsed.reason === "string"
                ? { lastFailureReason: parsed.reason }
                : {}),
            ...(typeof parsed.updatedAt === "string"
                ? { updatedAt: parsed.updatedAt }
                : isRecord(parsed.task) && typeof parsed.task.updatedAt === "string"
                    ? { updatedAt: parsed.task.updatedAt }
                    : {}),
            ...(baseCommit === undefined ? {} : { baseCommit }),
            ...(patchPath === undefined ? {} : { patchPath }),
            ...(summaryPath === undefined ? {} : { summaryPath }),
            ...(artifacts.length === 0 ? {} : { artifacts }),
            strict: isStrictRuntimeResultBrief(parsed),
        };
    }
    catch {
        return {};
    }
}
export async function safeTail(path, lines) {
    try {
        return await tailCodexGoalLog(path, lines);
    }
    catch {
        return "";
    }
}
function runtimeResultArtifacts(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((item) => {
        if (!isRecord(item) || typeof item.kind !== "string")
            return [];
        return [{
                kind: item.kind,
                ...(typeof item.path === "string" ? { path: item.path } : {}),
                ...(typeof item.byteLength === "number" ? { byteLength: item.byteLength } : {}),
            }];
    });
}
function runtimeResultArtifactPath(artifacts, kind) {
    return artifacts.find((artifact) => artifact.kind === kind && typeof artifact.path === "string")?.path;
}
function runtimeResultBaseCommit(parsed) {
    if (typeof parsed.baseCommit === "string" && parsed.baseCommit.trim()) {
        return parsed.baseCommit.trim();
    }
    if (isRecord(parsed.details) &&
        typeof parsed.details.baseCommit === "string" &&
        parsed.details.baseCommit.trim()) {
        return parsed.details.baseCommit.trim();
    }
    return undefined;
}
function isStrictRuntimeResultBrief(parsed) {
    return (typeof parsed.status === "string" &&
        Array.isArray(parsed.changedFiles) &&
        parsed.changedFiles.every((item) => typeof item === "string") &&
        Array.isArray(parsed.evidence) &&
        parsed.evidence.every((item) => typeof item === "string") &&
        Array.isArray(parsed.blockers) &&
        parsed.blockers.every((item) => typeof item === "string") &&
        typeof parsed.nextAction === "string");
}
function lastRecord(values) {
    for (let index = values.length - 1; index >= 0; index -= 1) {
        const value = values[index];
        if (isRecord(value))
            return value;
    }
    return undefined;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=codex-goal-runtime-result.js.map