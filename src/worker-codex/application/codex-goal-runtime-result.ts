import { readFile } from "node:fs/promises";
import type { RuntimeResultArtifact } from "@vioxen/subscription-runtime/worker-core";
import { CODEX_GOAL_CONTINUATION_WORKSPACE_FINGERPRINT_SCHEMA } from "../codex-goal-continuation-workspace-fingerprint";
import { tailCodexGoalLog } from "../codex-goal-ops";

export async function readRuntimeResultBrief(path: string): Promise<{
  readonly status?: string;
  readonly changedFiles?: readonly string[];
  readonly currentAccount?: string;
  readonly lastFailureReason?: string;
  readonly updatedAt?: string;
  readonly strict?: boolean;
  readonly baseCommit?: string;
  readonly patchPath?: string;
  readonly summaryPath?: string;
  readonly manifestPath?: string;
  readonly manifestSha256?: string;
  readonly handoffArtifactError?: string;
  readonly continuationWorkspaceFingerprint?: {
    readonly schema: typeof CODEX_GOAL_CONTINUATION_WORKSPACE_FINGERPRINT_SCHEMA;
    readonly sha256: string;
  };
  readonly artifacts?: readonly RuntimeResultArtifact[];
}> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) return {};
    const attempts = Array.isArray(parsed.attempts) ? parsed.attempts : [];
    const lastAttempt = lastRecord(attempts);
    const artifacts = runtimeResultArtifacts(parsed.artifacts);
    const patchPath = runtimeResultArtifactPath(artifacts, "patch");
    const summaryPath = runtimeResultArtifactPath(artifacts, "summary");
    const manifestPath = runtimeResultArtifactPath(artifacts, "manifest");
    const manifestSha256 = runtimeResultArtifactSha256(artifacts, "manifest");
    const baseCommit = runtimeResultBaseCommit(parsed);
    const handoffArtifactError = runtimeResultHandoffArtifactError(parsed);
    const continuationWorkspaceFingerprint =
      runtimeResultContinuationWorkspaceFingerprint(parsed);
    const strict = isStrictRuntimeResultBrief(parsed);
    return {
      ...(strict
        ? {
            status: parsed.status as string,
            changedFiles: parsed.changedFiles as readonly string[],
          }
        : {}),
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
      ...(manifestPath === undefined ? {} : { manifestPath }),
      ...(manifestSha256 === undefined ? {} : { manifestSha256 }),
      ...(handoffArtifactError === undefined ? {} : { handoffArtifactError }),
      ...(continuationWorkspaceFingerprint === undefined
        ? {}
        : { continuationWorkspaceFingerprint }),
      ...(artifacts.length === 0 ? {} : { artifacts }),
      strict,
    };
  } catch {
    return {};
  }
}

function runtimeResultContinuationWorkspaceFingerprint(
  parsed: Record<string, unknown>,
):
  | {
      readonly schema: typeof CODEX_GOAL_CONTINUATION_WORKSPACE_FINGERPRINT_SCHEMA;
      readonly sha256: string;
    }
  | undefined {
  if (!isRecord(parsed.details)) return undefined;
  const schema = parsed.details.continuationWorkspaceFingerprintSchema;
  const sha256 = parsed.details.continuationWorkspaceFingerprintSha256;
  return schema === CODEX_GOAL_CONTINUATION_WORKSPACE_FINGERPRINT_SCHEMA &&
      typeof sha256 === "string" && /^[a-f0-9]{64}$/i.test(sha256)
    ? { schema, sha256: sha256.toLowerCase() }
    : undefined;
}

function runtimeResultHandoffArtifactError(
  parsed: Record<string, unknown>,
): string | undefined {
  if (!isRecord(parsed.details)) return undefined;
  const value = parsed.details.handoffArtifactError;
  return typeof value === "string" && /^handoff_[a-z0-9_]+$/.test(value)
    ? value
    : undefined;
}

export async function safeTail(path: string, lines: number): Promise<string> {
  try {
    return await tailCodexGoalLog(path, lines);
  } catch {
    return "";
  }
}

function runtimeResultArtifacts(value: unknown): readonly RuntimeResultArtifact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): RuntimeResultArtifact[] => {
    if (!isRecord(item) || typeof item.kind !== "string") return [];
    return [{
      kind: item.kind,
      ...(typeof item.path === "string" ? { path: item.path } : {}),
      ...(typeof item.byteLength === "number" ? { byteLength: item.byteLength } : {}),
      ...(typeof item.sha256 === "string" ? { sha256: item.sha256 } : {}),
    }];
  });
}

function runtimeResultArtifactPath(
  artifacts: readonly RuntimeResultArtifact[],
  kind: string,
): string | undefined {
  return artifacts.find((artifact) =>
    artifact.kind === kind && typeof artifact.path === "string"
  )?.path;
}

function runtimeResultArtifactSha256(
  artifacts: readonly RuntimeResultArtifact[],
  kind: string,
): string | undefined {
  return artifacts.find((artifact) =>
    artifact.kind === kind && typeof artifact.sha256 === "string"
  )?.sha256;
}

function runtimeResultBaseCommit(parsed: Record<string, unknown>): string | undefined {
  if (typeof parsed.baseCommit === "string" && parsed.baseCommit.trim()) {
    return parsed.baseCommit.trim();
  }
  if (
    isRecord(parsed.details) &&
    typeof parsed.details.baseCommit === "string" &&
    parsed.details.baseCommit.trim()
  ) {
    return parsed.details.baseCommit.trim();
  }
  return undefined;
}

function isStrictRuntimeResultBrief(parsed: Record<string, unknown>): boolean {
  return (
    typeof parsed.status === "string" &&
    Array.isArray(parsed.changedFiles) &&
    parsed.changedFiles.every((item) => typeof item === "string") &&
    Array.isArray(parsed.evidence) &&
    parsed.evidence.every((item) => typeof item === "string") &&
    Array.isArray(parsed.blockers) &&
    parsed.blockers.every((item) => typeof item === "string") &&
    typeof parsed.nextAction === "string"
  );
}

function lastRecord(values: readonly unknown[]): Record<string, unknown> | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (isRecord(value)) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
