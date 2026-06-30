import { type RunControlInboxSummary, type RunObservationPort, type RunObservationRequest, type RunObservationSnapshot } from "@vioxen/subscription-runtime/worker-core";
import { type CodexGoalJobManifest } from "./codex-goal-jobs.js";
export type CodexRunObservationAdapterOptions = {
    readonly registryRootDir?: string;
    readonly cwd?: string;
    readonly staleAfterMs?: number;
    readonly tailLines?: number;
    readonly controlInboxReader?: (input: {
        readonly runId: string;
        readonly manifest: CodexGoalJobManifest;
    }) => Promise<RunControlInboxSummary | undefined>;
};
export declare class CodexRunObservationAdapter implements RunObservationPort {
    private readonly options;
    private readonly cwd;
    private readonly registryRootDir;
    private readonly staleAfterMs;
    private readonly tailLines;
    private readonly redactor;
    constructor(options?: CodexRunObservationAdapterOptions);
    listRunIds(): Promise<readonly string[]>;
    observeRun(request: RunObservationRequest): Promise<RunObservationSnapshot>;
    private controlInboxSummary;
    private capacityHints;
    private logExcerpt;
}
//# sourceMappingURL=codex-run-observation.d.ts.map