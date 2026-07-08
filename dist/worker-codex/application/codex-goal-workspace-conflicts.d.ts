/// <reference types="node" />
type JsonObject = Readonly<Record<string, unknown>>;
export declare function buildCodexGoalWorkspaceConflicts(jobs: readonly JsonObject[]): Promise<readonly JsonObject[]>;
export declare function workspaceConflictKey(workspacePath: string): Promise<string>;
export declare function workspaceConflictJobIds(conflicts: readonly JsonObject[]): ReadonlySet<string>;
export declare function applyWorkspaceConflictToOverviewJob(input: {
    readonly job: JsonObject;
    readonly conflictJobIds: ReadonlySet<string>;
}): JsonObject;
export {};
//# sourceMappingURL=codex-goal-workspace-conflicts.d.ts.map