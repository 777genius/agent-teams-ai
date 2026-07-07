import { join } from "node:path";
import { LocalIntegrationAttemptStore } from "@vioxen/subscription-runtime/store-local-file";
import {
  LocalGitIntegrationAdapter,
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
  });
}

function localProjectIntegrationDeps(
  controller: ProjectIntegrationMcpController,
): ProjectIntegrationMcpUseCaseDeps {
  const rootDir = join(controller.controller.jobRootDir, "project-integration");
  return {
    store: new LocalIntegrationAttemptStore({ rootDir }),
    git: new LocalGitIntegrationAdapter({
      allowedPatchRoots: controller.scope.workspaceRoots ?? [],
    }),
    checks: new LocalProjectCheckRunner(),
    scanner: new SimpleSecretScanner(),
    locks: new LocalWorkspaceIntegrationLock({
      rootDir: join(rootDir, "locks"),
      staleLockMs: 30 * 60_000,
    }),
  };
}
