import { isAbsolute, relative, resolve } from "node:path";

import type {
  HandoffContractInput,
  HandoffManifest,
  HandoffStatus,
  HandoffValidationIssue,
} from "../domain/handoff-contract";

export class ValidateHandoffContractUseCase {
  validate(input: HandoffContractInput): HandoffManifest {
    const changedFiles = input.changedFiles ?? [];
    const checks = input.checks ?? [];
    const handoffRequired = input.handoffRequired ??
      Boolean(input.workspaceDirty || changedFiles.length > 0);
    const issues = validateIssues({ ...input, changedFiles, handoffRequired });
    const status = handoffStatus({ handoffRequired, issues });

    return {
      workerJobId: input.workerJobId,
      workspacePath: input.workspacePath,
      ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
      ...(input.patchPath === undefined ? {} : { patchPath: input.patchPath }),
      ...(input.summaryPath === undefined ? {} : { summaryPath: input.summaryPath }),
      ...(input.manifestPath === undefined ? {} : { manifestPath: input.manifestPath }),
      ...(input.manifestSha256 === undefined
        ? {}
        : { manifestSha256: input.manifestSha256 }),
      changedFiles,
      checks,
      createdAt: input.createdAt,
      status,
      issues,
    };
  }
}

export function validateHandoffContract(
  input: HandoffContractInput,
): HandoffManifest {
  return new ValidateHandoffContractUseCase().validate(input);
}

function validateIssues(input: HandoffContractInput & {
  readonly changedFiles: readonly string[];
  readonly handoffRequired: boolean;
}): readonly HandoffValidationIssue[] {
  const issues: HandoffValidationIssue[] = [];
  if (!input.handoffRequired) return issues;
  if (!input.patchPath && !input.summaryPath && !input.manifestPath) {
    issues.push({
      code: "handoff_artifact_missing",
      severity: "blocked",
      message:
        "Worker changed the workspace but did not provide a patch or summary handoff artifact.",
      evidence: input.changedFiles,
    });
  }
  if (!input.baseCommit) {
    issues.push({
      code: "base_commit_missing",
      severity: "warning",
      message:
        "Worker handoff does not declare the base commit. Integration should verify stale-base risk before applying output.",
    });
  }
  if (input.manifestPath && !/^[a-f0-9]{64}$/i.test(input.manifestSha256 ?? "")) {
    issues.push({
      code: "handoff_manifest_hash_missing",
      severity: "blocked",
      message: "Worker handoff manifest does not declare a valid SHA-256 hash.",
      evidence: [input.manifestPath],
    });
  }
  const artifactRootPath = input.artifactRootPath ?? input.workspacePath;
  for (const artifactPath of [
    input.patchPath,
    input.summaryPath,
    input.manifestPath,
  ]) {
    if (artifactPath && !pathInside(artifactRootPath, artifactPath)) {
      issues.push({
        code: "handoff_path_outside_workspace",
        severity: "blocked",
        message: "Handoff artifact path is outside the owned artifact root.",
        evidence: [artifactPath],
      });
    }
  }
  for (const check of input.checks ?? []) {
    if (check.status === "failed") {
      issues.push({
        code: "handoff_check_failed",
        severity: "blocked",
        message: "Worker handoff includes a failed check.",
        evidence: [check.checkId],
      });
    }
  }
  return issues;
}

function handoffStatus(input: {
  readonly handoffRequired: boolean;
  readonly issues: readonly HandoffValidationIssue[];
}): HandoffStatus {
  if (!input.handoffRequired) return "not_required";
  if (input.issues.some((issue) => issue.severity === "blocked")) return "invalid";
  if (input.issues.some((issue) => issue.severity === "warning")) return "unknown";
  return "valid";
}

function pathInside(rootPath: string, path: string): boolean {
  const resolvedRoot = resolve(rootPath);
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(rootPath, path);
  const rel = relative(resolvedRoot, resolvedPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
