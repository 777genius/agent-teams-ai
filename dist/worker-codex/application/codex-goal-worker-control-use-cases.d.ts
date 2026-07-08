/// <reference types="node" />
import { type ActiveAttemptRegistry } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobIdInput, CodexGoalWorkerControlInput } from "./codex-goal-use-case-inputs.js";
type JsonObject = Readonly<Record<string, unknown>>;
export type CodexGoalWorkerControlUseCaseOptions = {
    readonly activeAttemptRegistry?: ActiveAttemptRegistry;
};
export declare function pauseCodexGoalWorker(args: CodexGoalJobIdInput): Promise<JsonObject>;
export declare function sendCodexGoalGuidance(args: CodexGoalWorkerControlInput & {
    readonly message?: string;
}, options?: CodexGoalWorkerControlUseCaseOptions): Promise<JsonObject>;
export declare function enqueueCodexGoalControlSignal(args: CodexGoalWorkerControlInput): Promise<JsonObject>;
export declare function listCodexGoalControlSignals(args: CodexGoalWorkerControlInput): Promise<JsonObject>;
export declare function inspectCodexGoalControlDecision(args: CodexGoalWorkerControlInput): Promise<JsonObject>;
export declare function reconcileCodexGoalControlInbox(args: CodexGoalWorkerControlInput): Promise<JsonObject>;
export declare function supersedeCodexGoalControlSignal(args: CodexGoalWorkerControlInput): Promise<JsonObject>;
export {};
//# sourceMappingURL=codex-goal-worker-control-use-cases.d.ts.map