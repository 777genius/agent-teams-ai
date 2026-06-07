import type { OutputSink, ProcessResult, RedactorPort, RunnerPort } from "@vioxen/subscription-runtime/core";
export type GitHubActionRunnerOptions = {
    readonly redactor?: RedactorPort;
    readonly maxCapturedOutputBytes?: number;
};
export declare class GitHubActionRunner implements RunnerPort {
    readonly runnerId: string;
    readonly capabilities: import("@vioxen/subscription-runtime/core").RunnerCapabilities;
    private readonly redactor;
    private readonly maxCapturedOutputBytes;
    constructor(options?: GitHubActionRunnerOptions);
    run(input: {
        readonly command: string;
        readonly args: readonly string[];
        readonly cwd: string;
        readonly env: Readonly<Record<string, string>>;
        readonly stdin?: Uint8Array;
        readonly timeoutMs: number;
        readonly stdout?: OutputSink;
        readonly stderr?: OutputSink;
        readonly abortSignal: AbortSignal;
    }): Promise<ProcessResult>;
}
//# sourceMappingURL=github-action-runner.d.ts.map