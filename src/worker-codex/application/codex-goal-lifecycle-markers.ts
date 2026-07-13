import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import type {
  ReviewedWorkerOutputSnapshot,
} from "../reviewed-worker-output";

type JsonObject = Readonly<Record<string, unknown>>;

type CodexGoalLifecycleBrief = {
  readonly silentStale?: boolean | undefined;
  readonly heartbeatOnlyNoOutput?: boolean | undefined;
  readonly lastProgressAt?: string | undefined;
  readonly lastProgressAgeMs?: number | undefined;
  readonly staleAfterMs?: number | undefined;
  readonly logByteLength?: number | undefined;
};

type CodexGoalLifecycleMarkerSpec = {
  readonly type: "pause_request" | "maintenance_pause" | "review" | "stop_event";
  readonly suffix: string;
  readonly timestampKeys: readonly string[];
};

const lifecycleMarkerSpecs: readonly CodexGoalLifecycleMarkerSpec[] = [
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

export async function readCodexGoalLifecycleMarkers(input: {
  readonly jobRootDir: string;
  readonly taskId: string;
}): Promise<readonly JsonObject[]> {
  const markers = await Promise.all(
    lifecycleMarkerSpecs.map((spec) =>
      readCodexGoalLifecycleMarker({
        ...input,
        spec,
      })
    ),
  );
  return markers
    .filter((marker): marker is JsonObject => marker !== undefined)
    .sort((left, right) =>
      Date.parse(String(right.timestamp ?? right.updatedAt ?? "0")) -
      Date.parse(String(left.timestamp ?? left.updatedAt ?? "0"))
    );
}

export async function writeCodexGoalReviewMarker(input: {
  readonly jobId: string;
  readonly taskId: string;
  readonly jobRootDir: string;
  readonly note: string;
  readonly status: unknown;
  readonly reviewedOutput?: ReviewedWorkerOutputSnapshot;
}): Promise<string> {
  await mkdir(input.jobRootDir, { recursive: true, mode: 0o700 });
  const reviewPath = join(input.jobRootDir, `${input.taskId}.review.json`);
  await writeFile(
    reviewPath,
    `${JSON.stringify({
      schemaVersion: 1,
      jobId: input.jobId,
      taskId: input.taskId,
      reviewedAt: new Date().toISOString(),
      note: input.note,
      status: input.status,
      ...(input.reviewedOutput
        ? {
            reviewedOutput: {
              reviewedOutputId: input.reviewedOutput.reviewedOutputId,
              patchSha256: input.reviewedOutput.patchSha256,
              patchPath: input.reviewedOutput.patchPath,
              baseCommit: input.reviewedOutput.baseCommit,
              changedFiles: input.reviewedOutput.changedFiles,
              reviewedBy: input.reviewedOutput.reviewDecision.reviewedBy,
              decision: input.reviewedOutput.reviewDecision.decision,
              capturedAt: input.reviewedOutput.capturedAt,
            },
          }
        : {}),
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return reviewPath;
}

export async function writeCodexGoalStopEvent(input: {
  readonly jobId: string;
  readonly taskId: string;
  readonly jobRootDir: string;
  readonly tmuxSession?: string;
  readonly stopCommand: string;
  readonly forceStop: boolean;
  readonly statusBefore: unknown;
  readonly statusAfter: unknown;
  readonly brief: CodexGoalLifecycleBrief;
}): Promise<string> {
  await mkdir(input.jobRootDir, { recursive: true, mode: 0o700 });
  const path = join(input.jobRootDir, `${input.taskId}.stop-event.json`);
  await writeFile(
    path,
    `${JSON.stringify({
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
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return path;
}

export async function writeCodexGoalMaintenancePauseEvent(input: {
  readonly jobId: string;
  readonly taskId: string;
  readonly jobRootDir: string;
  readonly tmuxSession: string;
  readonly stopCommand: string;
  readonly reason: string;
  readonly forcePause: boolean;
  readonly statusBefore: unknown;
  readonly statusAfter: unknown;
  readonly brief: CodexGoalLifecycleBrief;
}): Promise<string> {
  await mkdir(input.jobRootDir, { recursive: true, mode: 0o700 });
  const path = join(input.jobRootDir, `${input.taskId}.maintenance-pause.json`);
  await writeFile(
    path,
    `${JSON.stringify({
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
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return path;
}

export async function writeCodexGoalStoppedProgress(input: {
  readonly progressPath: string;
  readonly taskId: string;
  readonly status: "stopped" | "maintenance_paused";
  readonly reason?: string;
}): Promise<void> {
  await mkdir(dirname(input.progressPath), { recursive: true, mode: 0o700 });
  const tempPath = `${input.progressPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    tempPath,
    `${JSON.stringify({
      schemaVersion: 1,
      taskId: input.taskId,
      updatedAt: new Date().toISOString(),
      status: input.status,
      ...(input.reason ? { reason: input.reason } : {}),
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(tempPath, input.progressPath);
}

async function readCodexGoalLifecycleMarker(input: {
  readonly jobRootDir: string;
  readonly taskId: string;
  readonly spec: CodexGoalLifecycleMarkerSpec;
}): Promise<JsonObject | undefined> {
  const markerPath = join(input.jobRootDir, `${input.taskId}.${input.spec.suffix}`);
  try {
    const [metadata, raw] = await Promise.all([
      stat(markerPath),
      readFile(markerPath, "utf8"),
    ]);
    const parsed = parseLifecycleMarker(raw);
    const timestamp = firstStringKey(parsed, input.spec.timestampKeys);
    const brief = isRecord(parsed.brief) ? parsed.brief : {};
    const reviewedOutput = isRecord(parsed.reviewedOutput)
      ? parsed.reviewedOutput
      : {};
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
      ...(typeof reviewedOutput.reviewedOutputId === "string"
        ? { reviewedOutputId: reviewedOutput.reviewedOutputId }
        : {}),
      ...(typeof reviewedOutput.patchSha256 === "string"
        ? { reviewedOutputPatchSha256: reviewedOutput.patchSha256 }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function parseLifecycleMarker(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstStringKey(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return redactText(value.trim());
  }
  return undefined;
}

function statusField(status: unknown, key: string): unknown {
  return isRecord(status) ? status[key] : undefined;
}

function changedFilesFromStatus(status: unknown): readonly unknown[] {
  const changedFiles = statusField(status, "changedFiles");
  return Array.isArray(changedFiles) ? changedFiles : [];
}

function redactText(value: string): string {
  return new DefaultRedactor().redact(value);
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
