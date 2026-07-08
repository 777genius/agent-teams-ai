/// <reference types="node" />
import type { ProjectAccessScope, ProjectAdmissionWorkerRole, ProjectControlBroker, ProjectControlOperationResult } from "@vioxen/subscription-runtime/worker-core";
import { type CodexGoalJobManifest, type CodexGoalJobManifestInput } from "./codex-goal-jobs.js";
import { type CodexGoalProjectCreateWorktreeInput } from "./codex-goal-mcp-project-broker.js";
export declare function readTextFileIfExists(path: string): Promise<string | null>;
export declare function assertReadablePrompt(input: {
    readonly promptPath: string;
    readonly expectedBody?: string;
}): Promise<{
    readonly promptPath: string;
    readonly bytes: number;
}>;
export declare function createOrReuseProjectWorktree(input: {
    readonly broker: ProjectControlBroker;
    readonly createWorktreeInput: CodexGoalProjectCreateWorktreeInput;
}): Promise<{
    readonly result: ProjectControlOperationResult;
    readonly created: boolean;
}>;
export declare function rollbackProjectRefillPartial(input: {
    readonly sourceWorkspacePath: string;
    readonly workspacePath: string;
    readonly promptPath: string;
    readonly registryRootDir: string;
    readonly jobId: string;
    readonly worktreeCreated: boolean;
    readonly promptWritten: boolean;
}): Promise<readonly string[]>;
export declare function createOrReuseProjectJob(input: {
    readonly broker: ProjectControlBroker;
    readonly registryRootDir: string;
    readonly scope: ProjectAccessScope;
    readonly manifest: CodexGoalJobManifestInput;
    readonly promptBody: string;
    readonly workerRole?: ProjectAdmissionWorkerRole | `${ProjectAdmissionWorkerRole}`;
}): Promise<{
    readonly result: ProjectControlOperationResult;
    readonly manifest: CodexGoalJobManifest;
}>;
//# sourceMappingURL=codex-goal-mcp-project-refill.d.ts.map