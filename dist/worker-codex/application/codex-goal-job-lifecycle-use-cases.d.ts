/// <reference types="node" />
import type { CodexGoalJobManifest } from "../codex-goal-jobs.js";
import { type CodexGoalLaunchInput } from "../codex-goal-ops.js";
import { type CodexGoalJobIdInput, type CodexGoalJobLifecycleInput, type CodexGoalJobResultReconcileInput } from "./codex-goal-use-case-inputs.js";
type JsonObject = Readonly<Record<string, unknown>>;
type LoadedCodexGoalJobLaunch = {
    readonly registryRootDir: string;
    readonly manifest: CodexGoalJobManifest;
    readonly launch: CodexGoalLaunchInput;
};
export type CodexGoalMcpJobLifecycleDeps = {
    readonly loadJobLaunch: (args: CodexGoalJobIdInput) => Promise<LoadedCodexGoalJobLaunch>;
};
export declare function continueStoredJobLifecycle(args: CodexGoalJobLifecycleInput, options: {
    readonly mode: "continue" | "recover";
    readonly confirmKey: "confirmContinue" | "confirmRecover";
}, deps: CodexGoalMcpJobLifecycleDeps): Promise<JsonObject>;
export declare function reconcileStoredJobRuntimeResultLifecycle(args: CodexGoalJobResultReconcileInput, deps: CodexGoalMcpJobLifecycleDeps): Promise<JsonObject>;
export declare function stopStoredJobLifecycle(args: CodexGoalJobLifecycleInput, deps: CodexGoalMcpJobLifecycleDeps): Promise<JsonObject>;
export declare function maintenancePauseStoredJobLifecycle(args: CodexGoalJobLifecycleInput, deps: CodexGoalMcpJobLifecycleDeps): Promise<JsonObject>;
export {};
//# sourceMappingURL=codex-goal-job-lifecycle-use-cases.d.ts.map