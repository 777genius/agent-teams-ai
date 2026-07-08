/// <reference types="node" />
import { type ActiveAttemptRegistry } from "@vioxen/subscription-runtime/worker-core";
import type { JobIdMcpArgs, WorkerControlMcpArgs } from "../codex-goal-mcp-inputs.js";
type JsonObject = Readonly<Record<string, unknown>>;
export type CodexGoalWorkerControlUseCaseOptions = {
    readonly activeAttemptRegistry?: ActiveAttemptRegistry;
};
export declare function pauseCodexGoalWorker(args: JobIdMcpArgs): Promise<JsonObject>;
export declare function sendCodexGoalGuidance(args: WorkerControlMcpArgs & {
    readonly message?: string;
}, options?: CodexGoalWorkerControlUseCaseOptions): Promise<JsonObject>;
export declare function enqueueCodexGoalControlSignal(args: WorkerControlMcpArgs): Promise<JsonObject>;
export declare function listCodexGoalControlSignals(args: WorkerControlMcpArgs): Promise<JsonObject>;
export declare function inspectCodexGoalControlDecision(args: WorkerControlMcpArgs): Promise<JsonObject>;
export declare function reconcileCodexGoalControlInbox(args: WorkerControlMcpArgs): Promise<JsonObject>;
export declare function supersedeCodexGoalControlSignal(args: WorkerControlMcpArgs): Promise<JsonObject>;
export {};
//# sourceMappingURL=codex-goal-worker-control-use-cases.d.ts.map