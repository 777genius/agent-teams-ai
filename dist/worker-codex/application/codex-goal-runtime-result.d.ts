/// <reference types="node" />
import type { RuntimeResultArtifact } from "@vioxen/subscription-runtime/worker-core";
export declare function readRuntimeResultBrief(path: string): Promise<{
    readonly currentAccount?: string;
    readonly lastFailureReason?: string;
    readonly updatedAt?: string;
    readonly strict?: boolean;
    readonly baseCommit?: string;
    readonly patchPath?: string;
    readonly summaryPath?: string;
    readonly artifacts?: readonly RuntimeResultArtifact[];
}>;
export declare function safeTail(path: string, lines: number): Promise<string>;
//# sourceMappingURL=codex-goal-runtime-result.d.ts.map