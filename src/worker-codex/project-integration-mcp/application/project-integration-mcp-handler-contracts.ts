import {
  applyWorkerOutput,
  commitApprovedChanges,
  openProjectIntegrationAttempt,
  pushApprovedCommit,
  rejectIntegrationAttempt,
  runRequiredChecks,
} from "@vioxen/subscription-runtime/worker-core";
import type {
  ProjectIntegrationMcpController,
  ProjectIntegrationMcpLoadController,
  ProjectIntegrationMcpResolvePathArg,
} from "../ports/project-integration-mcp-tool-handlers";

export type JsonObject = Readonly<Record<string, unknown>>;

export type ProjectIntegrationMcpUseCaseDeps =
  & Parameters<typeof openProjectIntegrationAttempt>[0]
  & Parameters<typeof applyWorkerOutput>[0]
  & Parameters<typeof runRequiredChecks>[0]
  & Parameters<typeof commitApprovedChanges>[0]
  & Parameters<typeof pushApprovedCommit>[0]
  & Parameters<typeof rejectIntegrationAttempt>[0];

export type CreateProjectIntegrationMcpToolHandlersOptions = {
  readonly loadController: ProjectIntegrationMcpLoadController;
  readonly resolvePathArg: ProjectIntegrationMcpResolvePathArg;
  readonly integrationDeps: (
    controller: ProjectIntegrationMcpController,
  ) => ProjectIntegrationMcpUseCaseDeps;
  readonly validateWorkerHandoffArtifact?: (input: {
    readonly controller: ProjectIntegrationMcpController;
    readonly workerJobId: string;
    readonly workspacePath: string;
    readonly patchPath: string;
    readonly summaryPath?: string;
    readonly manifestPath?: string;
    readonly manifestSha256?: string;
    readonly baseCommit?: string;
    readonly changedPaths: readonly string[];
  }) => Promise<{
    readonly baseCommit?: string;
    readonly manifestPath?: string;
    readonly summaryPath?: string;
  }>;
};
