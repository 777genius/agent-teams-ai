import type { OutputSink, ProcessResult, RunnerPort } from "@vioxen/subscription-runtime/core";
export type NodeProcessRunnerOptions = {
    readonly killGraceMs?: number;
};
export declare class NodeProcessRunner implements RunnerPort {
    private readonly options;
    readonly runnerId = "node-process-runner";
    readonly capabilities: {
        runnerId: string;
        supportsEnvAllowlist: boolean;
        supportsWorkingDirectory: boolean;
        supportsTimeout: boolean;
        supportsAbortSignal: boolean;
        supportsOutputRedaction: boolean;
        supportsReadOnlySandbox: boolean;
        readOnlyFilesystem: boolean;
        platform: "node-process";
    };
    constructor(options?: NodeProcessRunnerOptions);
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
//# sourceMappingURL=node-process-runner.d.ts.map