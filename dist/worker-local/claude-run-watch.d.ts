export type ClaudeRunWatchArgs = {
    readonly stateRootDir?: string;
    readonly runArtifactsRootDir?: string;
    readonly jobId?: string;
    readonly jobIds?: string | readonly string[];
    readonly staleAfterMs?: number;
    readonly tailLines?: number;
    readonly limit?: number;
    readonly includeChangedFiles?: boolean;
    readonly includeLogTail?: boolean;
};
export declare function watchClaudeRuns(args: ClaudeRunWatchArgs): Promise<Record<string, unknown>>;
//# sourceMappingURL=claude-run-watch.d.ts.map