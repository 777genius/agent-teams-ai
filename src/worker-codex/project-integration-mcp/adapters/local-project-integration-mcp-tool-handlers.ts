import { dirname, join } from "node:path";
import { LocalIntegrationAttemptStore } from "@vioxen/subscription-runtime/store-local-file";
import {
  LocalGitIntegrationAdapter,
  ConfiguredCommitIdentityAdapter,
  LocalIntegratedOutputLedgerAdapter,
  LocalProjectCheckRunner,
  LocalWorkspaceIntegrationLock,
  SimpleSecretScanner,
} from "@vioxen/subscription-runtime/worker-local";
import {
  createProjectIntegrationMcpToolHandlers,
  type CreateProjectIntegrationMcpToolHandlersOptions,
  type ProjectIntegrationMcpUseCaseDeps,
} from "../application/create-project-integration-mcp-tool-handlers";
import type {
  ProjectIntegrationMcpController,
  ProjectIntegrationMcpToolHandlers,
} from "../ports/project-integration-mcp-tool-handlers";
import { validateLocalWorkerHandoffArtifact } from "./local-worker-handoff-artifact-validator";

export type CreateLocalProjectIntegrationMcpToolHandlersOptions =
  Pick<
    CreateProjectIntegrationMcpToolHandlersOptions,
    "loadController" | "resolvePathArg"
  >;

export function createLocalProjectIntegrationMcpToolHandlers(
  options: CreateLocalProjectIntegrationMcpToolHandlersOptions,
): ProjectIntegrationMcpToolHandlers {
  return createProjectIntegrationMcpToolHandlers({
    ...options,
    integrationDeps: localProjectIntegrationDeps,
    validateWorkerHandoffArtifact: validateLocalWorkerHandoffArtifact,
  });
}

function localProjectIntegrationDeps(
  controller: ProjectIntegrationMcpController,
): ProjectIntegrationMcpUseCaseDeps {
  const rootDir = join(controller.controller.jobRootDir, "project-integration");
  const archiveRoot = projectIntegrationArchiveRoot(controller);
  return {
    store: new LocalIntegrationAttemptStore({ rootDir }),
    git: new LocalGitIntegrationAdapter({
      allowedPatchRoots: projectIntegrationAllowedPatchRoots(controller),
      workerJobRootParent: dirname(controller.controller.jobRootDir),
      controllerArchiveRoot: archiveRoot,
    }),
    commitIdentity: new ConfiguredCommitIdentityAdapter(
      controller.scope.commitIdentity,
    ),
    integratedOutputLedger: new LocalIntegratedOutputLedgerAdapter({
      ledgerRoots: controller.scope.consumedOutputLedgerRoots ?? [],
      archiveRoot,
    }),
    checks: new LocalProjectCheckRunner(),
    scanner: new SimpleSecretScanner(),
    locks: new LocalWorkspaceIntegrationLock({
      rootDir: join(rootDir, "locks"),
      staleLockMs: 30 * 60_000,
    }),
  };
}

function projectIntegrationAllowedPatchRoots(
  controller: ProjectIntegrationMcpController,
): readonly string[] {
  return [
    ...(controller.scope.workspaceRoots ?? []),
    ...(controller.scope.worktreeRoots ?? []),
  ];
}

function projectIntegrationArchiveRoot(
  controller: ProjectIntegrationMcpController,
): string {
  return join(controller.controller.jobRootDir, "archives");
}
