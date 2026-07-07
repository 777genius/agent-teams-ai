import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";

type JsonObject = Readonly<Record<string, unknown>>;

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
