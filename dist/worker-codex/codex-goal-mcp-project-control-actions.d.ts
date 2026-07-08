/// <reference types="node" />
import { type ProjectAccessScope, type ProjectControlBroker } from "@vioxen/subscription-runtime/worker-core";
import { type CodexGoalJobManifest } from "./codex-goal-jobs.js";
import { type CodexGoalLaunchInput } from "./codex-goal-ops.js";
import { type CodexProjectControlBrokerInput } from "./codex-goal-mcp-project-broker.js";
import type { JobIdMcpArgs, ProjectControlMcpArgs } from "./codex-goal-mcp-inputs.js";
type JsonObject = Readonly<Record<string, unknown>>;
type LoadedProjectControlController = {
    readonly registryRootDir: string;
    readonly controller: CodexGoalJobManifest;
    readonly scope: ProjectAccessScope;
};
type LoadedCodexGoalJobLaunch = {
    readonly registryRootDir: string;
    readonly manifest: CodexGoalJobManifest;
    readonly launch: CodexGoalLaunchInput;
};
export type CodexGoalMcpProjectControlActionsDeps = {
    readonly loadProjectControlController: (args: ProjectControlMcpArgs) => Promise<LoadedProjectControlController>;
    readonly loadJobLaunch: (args: JobIdMcpArgs) => Promise<LoadedCodexGoalJobLaunch>;
    readonly codexProjectControlBroker: (input: Omit<CodexProjectControlBrokerInput, "admissionDeps">) => ProjectControlBroker;
};
export declare function projectControlStartStoredJobView(args: ProjectControlMcpArgs, deps: CodexGoalMcpProjectControlActionsDeps): Promise<JsonObject>;
export declare function projectControlCreateWorktreeView(args: ProjectControlMcpArgs, deps: CodexGoalMcpProjectControlActionsDeps): Promise<JsonObject>;
export declare function projectControlIntegrateCommitView(args: ProjectControlMcpArgs, deps: CodexGoalMcpProjectControlActionsDeps): Promise<JsonObject>;
export declare function projectControlPushBranchView(args: ProjectControlMcpArgs, deps: CodexGoalMcpProjectControlActionsDeps): Promise<JsonObject>;
export declare function projectControlStopStoredJobView(args: ProjectControlMcpArgs, deps: CodexGoalMcpProjectControlActionsDeps): Promise<JsonObject>;
export declare function projectControlMarkReviewedView(args: ProjectControlMcpArgs, deps: CodexGoalMcpProjectControlActionsDeps): Promise<JsonObject>;
export {};
//# sourceMappingURL=codex-goal-mcp-project-control-actions.d.ts.map