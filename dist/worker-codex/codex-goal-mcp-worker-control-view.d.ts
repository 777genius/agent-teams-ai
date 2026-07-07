/// <reference types="node" />
import { type WorkerControlCaller, type WorkerControlDecision, type WorkerControlDeliveryReceipt, type WorkerControlSignal, type WorkerControlSignalView } from "@vioxen/subscription-runtime/worker-core";
import type { WorkerControlMcpArgs } from "./codex-goal-mcp-inputs.js";
type JsonObject = Readonly<Record<string, unknown>>;
export declare function signalIdList(value: unknown): readonly string[];
export declare function workerControlCallerArgs(args: WorkerControlMcpArgs): {
    readonly caller?: WorkerControlCaller;
};
export declare function parseIsoDate(value: string, name: string): Date;
export declare function workerControlDecisionJson(decision: WorkerControlDecision, includeBodies: boolean): JsonObject;
export declare function workerControlSignalViewJson(view: WorkerControlSignalView, includeBody: boolean): JsonObject;
export declare function workerControlSignalJson(signal: WorkerControlSignal, includeBody: boolean): JsonObject;
export declare function workerControlReceiptJson(receipt: WorkerControlDeliveryReceipt): JsonObject;
export declare function jobIdsFromValue(value: unknown): readonly string[];
export {};
//# sourceMappingURL=codex-goal-mcp-worker-control-view.d.ts.map