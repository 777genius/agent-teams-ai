import { type RunObservationPort, type RunObservationRequest, type RunObservationSnapshot } from "@vioxen/subscription-runtime/worker-core";
export type ClaudeRunObservationAdapterOptions = {
    readonly stateRootDir?: string;
    readonly runArtifactsRootDir?: string;
    readonly staleAfterMs?: number;
    readonly tailLines?: number;
};
export declare class ClaudeRunObservationAdapter implements RunObservationPort {
    private readonly options;
    private readonly store;
    private readonly staleAfterMs;
    private readonly tailLines;
    private readonly redactor;
    constructor(options?: ClaudeRunObservationAdapterOptions);
    listRunIds(): Promise<readonly string[]>;
    observeRun(request: RunObservationRequest): Promise<RunObservationSnapshot>;
    private logExcerpt;
}
//# sourceMappingURL=claude-run-observation.d.ts.map