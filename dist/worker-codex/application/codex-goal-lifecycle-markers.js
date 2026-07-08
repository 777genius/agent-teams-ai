import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
const lifecycleMarkerSpecs = [
    {
        type: "pause_request",
        suffix: "pause-request.json",
        timestampKeys: ["requestedAt"],
    },
    {
        type: "maintenance_pause",
        suffix: "maintenance-pause.json",
        timestampKeys: ["pausedAt"],
    },
    {
        type: "review",
        suffix: "review.json",
        timestampKeys: ["reviewedAt"],
    },
    {
        type: "stop_event",
        suffix: "stop-event.json",
        timestampKeys: ["stoppedAt"],
    },
];
export async function readCodexGoalLifecycleMarkers(input) {
    const markers = await Promise.all(lifecycleMarkerSpecs.map((spec) => readCodexGoalLifecycleMarker({
        ...input,
        spec,
    })));
    return markers
        .filter((marker) => marker !== undefined)
        .sort((left, right) => Date.parse(String(right.timestamp ?? right.updatedAt ?? "0")) -
        Date.parse(String(left.timestamp ?? left.updatedAt ?? "0")));
}
export async function writeCodexGoalReviewMarker(input) {
    await mkdir(input.jobRootDir, { recursive: true, mode: 0o700 });
    const reviewPath = join(input.jobRootDir, `${input.taskId}.review.json`);
    await writeFile(reviewPath, `${JSON.stringify({
        schemaVersion: 1,
        jobId: input.jobId,
        taskId: input.taskId,
        reviewedAt: new Date().toISOString(),
        note: input.note,
        status: input.status,
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return reviewPath;
}
export async function writeCodexGoalStopEvent(input) {
    await mkdir(input.jobRootDir, { recursive: true, mode: 0o700 });
    const path = join(input.jobRootDir, `${input.taskId}.stop-event.json`);
    await writeFile(path, `${JSON.stringify({
        schemaVersion: 1,
        jobId: input.jobId,
        taskId: input.taskId,
        stoppedAt: new Date().toISOString(),
        ...(input.tmuxSession === undefined ? {} : { tmuxSession: input.tmuxSession }),
        stopCommand: input.stopCommand,
        forceStop: input.forceStop,
        reason: input.brief.silentStale
            ? "silent_stale_worker"
            : input.brief.heartbeatOnlyNoOutput
                ? "heartbeat_only_no_output"
                : "manual_force_stop",
        brief: {
            silentStale: input.brief.silentStale,
            heartbeatOnlyNoOutput: input.brief.heartbeatOnlyNoOutput,
            lastProgressAt: input.brief.lastProgressAt,
            lastProgressAgeMs: input.brief.lastProgressAgeMs,
            staleAfterMs: input.brief.staleAfterMs,
            logByteLength: input.brief.logByteLength,
            workspaceDirty: statusField(input.statusBefore, "workspaceDirty"),
            changedFiles: changedFilesFromStatus(input.statusBefore),
        },
        statusBefore: input.statusBefore,
        statusAfter: input.statusAfter,
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return path;
}
export async function writeCodexGoalMaintenancePauseEvent(input) {
    await mkdir(input.jobRootDir, { recursive: true, mode: 0o700 });
    const path = join(input.jobRootDir, `${input.taskId}.maintenance-pause.json`);
    await writeFile(path, `${JSON.stringify({
        schemaVersion: 1,
        jobId: input.jobId,
        taskId: input.taskId,
        pausedAt: new Date().toISOString(),
        tmuxSession: input.tmuxSession,
        stopCommand: input.stopCommand,
        forcePause: input.forcePause,
        reason: input.reason,
        brief: {
            lastProgressAt: input.brief.lastProgressAt,
            lastProgressAgeMs: input.brief.lastProgressAgeMs,
            staleAfterMs: input.brief.staleAfterMs,
            logByteLength: input.brief.logByteLength,
            workspaceDirty: statusField(input.statusBefore, "workspaceDirty"),
            changedFiles: changedFilesFromStatus(input.statusBefore),
        },
        statusBefore: input.statusBefore,
        statusAfter: input.statusAfter,
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return path;
}
export async function writeCodexGoalStoppedProgress(input) {
    await mkdir(dirname(input.progressPath), { recursive: true, mode: 0o700 });
    const tempPath = `${input.progressPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify({
        schemaVersion: 1,
        taskId: input.taskId,
        updatedAt: new Date().toISOString(),
        pid: process.pid,
        status: input.status,
        ...(input.reason ? { reason: input.reason } : {}),
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, input.progressPath);
}
async function readCodexGoalLifecycleMarker(input) {
    const markerPath = join(input.jobRootDir, `${input.taskId}.${input.spec.suffix}`);
    try {
        const [metadata, raw] = await Promise.all([
            stat(markerPath),
            readFile(markerPath, "utf8"),
        ]);
        const parsed = parseLifecycleMarker(raw);
        const timestamp = firstStringKey(parsed, input.spec.timestampKeys);
        const brief = isRecord(parsed.brief) ? parsed.brief : {};
        return {
            type: input.spec.type,
            markerPath,
            updatedAt: metadata.mtime.toISOString(),
            ...(timestamp ? { timestamp } : {}),
            ...(typeof parsed.reason === "string" ? { reason: redactText(parsed.reason) } : {}),
            ...(typeof parsed.mode === "string" ? { mode: redactText(parsed.mode) } : {}),
            ...(typeof parsed.note === "string" ? { note: truncateText(redactText(parsed.note), 300) } : {}),
            ...(typeof parsed.forceStop === "boolean" ? { forceStop: parsed.forceStop } : {}),
            ...(typeof parsed.forcePause === "boolean" ? { forcePause: parsed.forcePause } : {}),
            ...(typeof brief.silentStale === "boolean" ? { silentStale: brief.silentStale } : {}),
            ...(typeof brief.lastProgressAt === "string"
                ? { lastProgressAt: brief.lastProgressAt }
                : {}),
            ...(typeof brief.lastProgressAgeMs === "number"
                ? { lastProgressAgeMs: brief.lastProgressAgeMs }
                : {}),
            ...(typeof brief.logByteLength === "number"
                ? { logByteLength: brief.logByteLength }
                : {}),
            ...(typeof parsed.schemaVersion === "number" ? { schemaVersion: parsed.schemaVersion } : {}),
        };
    }
    catch {
        return undefined;
    }
}
function parseLifecycleMarker(raw) {
    try {
        const parsed = JSON.parse(raw);
        return isRecord(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
function firstStringKey(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim())
            return redactText(value.trim());
    }
    return undefined;
}
function statusField(status, key) {
    return isRecord(status) ? status[key] : undefined;
}
function changedFilesFromStatus(status) {
    const changedFiles = statusField(status, "changedFiles");
    return Array.isArray(changedFiles) ? changedFiles : [];
}
function redactText(value) {
    return new DefaultRedactor().redact(value);
}
function truncateText(value, maxLength) {
    if (value.length <= maxLength)
        return value;
    return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=codex-goal-lifecycle-markers.js.map