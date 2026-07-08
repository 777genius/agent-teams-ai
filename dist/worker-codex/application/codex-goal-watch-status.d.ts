/// <reference types="node" />
import type { RunReconcilePreviewStatus } from "@vioxen/subscription-runtime/worker-core";
type JsonObject = Readonly<Record<string, unknown>>;
export declare function codexOverviewItemToWatchStatus(item: JsonObject): Promise<RunReconcilePreviewStatus>;
export {};
//# sourceMappingURL=codex-goal-watch-status.d.ts.map