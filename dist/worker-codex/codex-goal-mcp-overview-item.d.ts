/// <reference types="node" />
type JsonObject = Readonly<Record<string, unknown>>;
export declare function buildCodexGoalOverviewItem(input: {
    readonly registryRootDir: string;
    readonly jobId: string;
    readonly staleAfterMs: number;
    readonly tailLines: number;
}): Promise<JsonObject>;
export {};
//# sourceMappingURL=codex-goal-mcp-overview-item.d.ts.map