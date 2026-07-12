import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";

export type ProjectIntegrationMcpToolResponse = CallToolResult;

export type ProjectIntegrationMcpToolHandler = (
  args: unknown,
) => Promise<ProjectIntegrationMcpToolResponse>;

export type ProjectIntegrationMcpToolHandlers = {
  readonly openAttempt: ProjectIntegrationMcpToolHandler;
  readonly applyWorkerOutput: ProjectIntegrationMcpToolHandler;
  readonly runRequiredChecks: ProjectIntegrationMcpToolHandler;
  readonly commitApprovedChanges: ProjectIntegrationMcpToolHandler;
  readonly pushApprovedCommit: ProjectIntegrationMcpToolHandler;
  readonly rejectAttempt: ProjectIntegrationMcpToolHandler;
};

export type ProjectIntegrationMcpArgs = {
  readonly registryRootDir?: string;
  readonly cwd?: string;
  readonly controllerJobId?: string;
  readonly attemptId?: string;
  readonly sourceWorkspacePath?: string;
  readonly workspacePath?: string;
  readonly branch?: string;
  readonly remote?: string;
  readonly force?: boolean;
  readonly commitSha?: string;
  readonly workerJobId?: string;
  readonly workerWorkspacePath?: string;
  readonly workerCommitSha?: string;
  readonly workerPatchPath?: string;
  readonly workerSummaryPath?: string;
  readonly workerHandoffManifestPath?: string;
  readonly workerHandoffManifestSha256?: string;
  readonly workerBaseCommit?: string;
  readonly targetWorkspacePath?: string;
  readonly targetCommit?: string;
  readonly baseStatus?: string;
  readonly baseRevisionReasons?: readonly string[] | string;
  readonly targetBranch?: string;
  readonly targetRemote?: string;
  readonly changedFiles?: readonly string[] | string;
  readonly approvedFiles?: readonly string[] | string;
  readonly allowedPathPrefixes?: readonly string[] | string;
  readonly requiredCheckIds?: readonly string[] | string;
  readonly requiredChecks?: readonly unknown[];
  readonly reviewedBy?: string;
  readonly reviewReason?: string;
  readonly allowStaleBase?: boolean;
  readonly allowedPreExistingDirtyFiles?: readonly string[] | string;
  readonly message?: string;
  readonly reason?: string;
  readonly confirmOpen?: boolean;
  readonly confirmApply?: boolean;
  readonly confirmRunChecks?: boolean;
  readonly confirmCommit?: boolean;
  readonly confirmPush?: boolean;
  readonly confirmReject?: boolean;
};

export type ProjectIntegrationMcpController = {
  readonly registryRootDir: string;
  readonly controller: {
    readonly jobId: string;
    readonly jobRootDir: string;
  };
  readonly scope: ProjectAccessScope;
};

export type ProjectIntegrationMcpLoadController = (
  args: ProjectIntegrationMcpArgs,
) => Promise<ProjectIntegrationMcpController>;

export type ProjectIntegrationMcpResolvePathArg = (
  args: ProjectIntegrationMcpArgs,
  value: unknown,
  fieldName: string,
) => string;
