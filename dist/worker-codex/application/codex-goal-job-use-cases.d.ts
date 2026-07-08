/// <reference types="node" />
import { type CodexGoalJobBriefInput, type CodexGoalJobCreateInput, type CodexGoalJobDecisionInput, type CodexGoalJobHandoffInput, type CodexGoalJobIdInput, type CodexGoalJobLifecycleInput, type CodexGoalJobOverviewInput, type CodexGoalJobRegistryInput, type CodexGoalJobResultReconcileInput, type CodexGoalJobUpdateInput, type CodexGoalJobWatchInput } from "./codex-goal-use-case-inputs.js";
type JsonObject = Readonly<Record<string, unknown>>;
export declare function listCodexGoalJobsUseCase(args: CodexGoalJobRegistryInput): Promise<JsonObject>;
export declare function buildCodexGoalOverviewUseCase(args: CodexGoalJobOverviewInput): Promise<JsonObject>;
export declare function reconcilePreviewCodexGoalJobsUseCase(args: CodexGoalJobWatchInput): Promise<JsonObject>;
export declare function getCodexGoalJobUseCase(args: CodexGoalJobIdInput): Promise<JsonObject>;
export declare function createCodexGoalJobUseCase(args: CodexGoalJobCreateInput): Promise<JsonObject>;
export declare function updateCodexGoalJobUseCase(args: CodexGoalJobUpdateInput): Promise<JsonObject>;
export declare function getCodexGoalStatusByIdUseCase(args: CodexGoalJobIdInput): Promise<JsonObject>;
export declare function recommendCodexGoalNextActionUseCase(args: CodexGoalJobIdInput): Promise<JsonObject>;
export declare function assertSingleCodexWriterUseCase(args: CodexGoalJobIdInput & Readonly<Record<string, unknown>>): Promise<JsonObject>;
export declare function reconcileStoredJobRuntimeResultUseCase(args: CodexGoalJobResultReconcileInput): Promise<JsonObject>;
export declare function continueStoredJobUseCase(args: CodexGoalJobLifecycleInput, options: {
    readonly mode: "continue" | "recover";
    readonly confirmKey: "confirmContinue" | "confirmRecover";
}): Promise<JsonObject>;
export declare function stopStoredJobUseCase(args: CodexGoalJobLifecycleInput): Promise<JsonObject>;
export declare function maintenancePauseStoredJobUseCase(args: CodexGoalJobLifecycleInput): Promise<JsonObject>;
export declare function markCodexGoalReviewedUseCase(args: CodexGoalJobIdInput & Readonly<{
    note?: unknown;
}>): Promise<JsonObject>;
export declare function buildCodexGoalBriefUseCase(args: CodexGoalJobBriefInput): Promise<JsonObject>;
export declare function buildCodexGoalDecisionUseCase(args: CodexGoalJobDecisionInput): Promise<JsonObject>;
export declare function buildCodexGoalHandoffUseCase(args: CodexGoalJobHandoffInput): Promise<JsonObject>;
export {};
//# sourceMappingURL=codex-goal-job-use-cases.d.ts.map