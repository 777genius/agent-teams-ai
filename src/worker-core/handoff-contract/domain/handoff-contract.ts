export type HandoffStatus =
  | "valid"
  | "invalid"
  | "not_required"
  | "unknown";

export type HandoffValidationSeverity = "warning" | "blocked";

export type HandoffValidationIssue = {
  readonly code: string;
  readonly severity: HandoffValidationSeverity;
  readonly message: string;
  readonly evidence?: readonly string[];
};

export type HandoffArtifact = {
  readonly kind: "patch" | "summary" | "manifest";
  readonly path: string;
  readonly exists?: boolean;
};

export type HandoffCheck = {
  readonly checkId: string;
  readonly status: "passed" | "failed" | "skipped" | "unknown";
};

export type HandoffManifest = {
  readonly workerJobId: string;
  readonly workspacePath: string;
  readonly baseCommit?: string;
  readonly patchPath?: string;
  readonly summaryPath?: string;
  readonly manifestPath?: string;
  readonly manifestSha256?: string;
  readonly changedFiles: readonly string[];
  readonly checks: readonly HandoffCheck[];
  readonly createdAt: string;
  readonly status: HandoffStatus;
  readonly issues: readonly HandoffValidationIssue[];
};

export type HandoffContractInput = {
  readonly workerJobId: string;
  readonly workspacePath: string;
  readonly createdAt: string;
  readonly baseCommit?: string;
  readonly patchPath?: string;
  readonly summaryPath?: string;
  readonly manifestPath?: string;
  readonly manifestSha256?: string;
  readonly artifactRootPath?: string;
  readonly changedFiles?: readonly string[];
  readonly checks?: readonly HandoffCheck[];
  readonly workspaceDirty?: boolean;
  readonly handoffRequired?: boolean;
};
