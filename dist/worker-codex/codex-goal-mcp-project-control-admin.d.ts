/// <reference types="node" />
import { type ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { type CodexGoalJobManifest } from "./codex-goal-jobs.js";
import type { JobUpdateMcpArgs, ProjectControlMcpArgs } from "./codex-goal-mcp-inputs.js";
import { type CodexProjectAdmissionDeps } from "./application/project-control/codex-goal-project-admission.js";
type JsonObject = Readonly<Record<string, unknown>>;
type LoadedProjectControlController = {
    readonly registryRootDir: string;
    readonly controller: CodexGoalJobManifest;
    readonly scope: ProjectAccessScope;
};
export type CodexGoalMcpProjectControlAdminDeps = {
    readonly loadProjectControlController: (args: ProjectControlMcpArgs) => Promise<LoadedProjectControlController>;
    readonly admissionDeps: CodexProjectAdmissionDeps;
};
export declare function projectControlAdmissionSnapshotView(args: ProjectControlMcpArgs, deps: CodexGoalMcpProjectControlAdminDeps): Promise<JsonObject>;
export declare function projectControlUpdateControllerScopeView(args: ProjectControlMcpArgs, deps: CodexGoalMcpProjectControlAdminDeps): Promise<JsonObject>;
export declare function projectControlRepairJobManifestView(args: ProjectControlMcpArgs & JobUpdateMcpArgs, deps: CodexGoalMcpProjectControlAdminDeps): Promise<JsonObject>;
export {};
//# sourceMappingURL=codex-goal-mcp-project-control-admin.d.ts.map