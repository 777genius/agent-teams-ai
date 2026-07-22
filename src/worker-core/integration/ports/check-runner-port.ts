import type {
  CheckRun,
  ProjectIntegrationCheckSpec,
} from "../domain/integration-attempt";

export interface CheckRunnerPort {
  runCheck(input: {
    readonly workspacePath: string;
    readonly allowedWorkspaceFiles: readonly string[];
    readonly check: ProjectIntegrationCheckSpec;
    readonly startedAt: string;
  }): Promise<CheckRun> | CheckRun;
}
