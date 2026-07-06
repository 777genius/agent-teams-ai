/// <reference types="node" />
export type ProjectControlOperationToolName = "codex_goal_project_refill_worker";
export declare enum ProjectControlOperationStatus {
    Queued = "queued",
    Running = "running",
    Completed = "completed",
    Failed = "failed"
}
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
    readonly [key: string]: JsonValue;
};
export type JsonRecord = {
    readonly [key: string]: JsonValue;
};
export type ProjectControlOperationRecord = {
    readonly operationId: string;
    readonly toolName: ProjectControlOperationToolName;
    readonly status: ProjectControlOperationStatus;
    readonly controllerJobId: string;
    readonly targetJobId?: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly args: JsonRecord;
    readonly operationFilePath: string;
    readonly resultPath: string;
    readonly logPath: string;
    readonly runner?: {
        readonly hostname: string;
        readonly pid: number;
        readonly command: readonly string[];
        readonly startedAt: string;
    };
    readonly runningAt?: string;
    readonly completedAt?: string;
    readonly failedAt?: string;
    readonly result?: JsonRecord;
    readonly error?: string;
};
export type ProjectControlOperationView = Omit<ProjectControlOperationRecord, "args" | "result"> & {
    readonly result?: JsonRecord;
};
export type ProjectControlOperationRunResult = {
    readonly ok: boolean;
    readonly operation: ProjectControlOperationRecord;
};
export declare function projectControlOperationsRoot(controllerJobRootDir: string): string;
export declare function projectControlOperationFilePath(input: {
    readonly operationsRootDir: string;
    readonly operationId: string;
}): string;
export declare function createProjectControlOperation(input: {
    readonly operationsRootDir: string;
    readonly controllerJobId: string;
    readonly toolName: ProjectControlOperationToolName;
    readonly args: JsonRecord;
    readonly targetJobId?: string;
}): Promise<ProjectControlOperationRecord>;
export declare function readProjectControlOperation(operationFilePath: string): Promise<ProjectControlOperationRecord>;
export declare function readProjectControlOperationById(input: {
    readonly operationsRootDir: string;
    readonly operationId: string;
}): Promise<ProjectControlOperationRecord>;
export declare function patchProjectControlOperation(input: {
    readonly operationFilePath: string;
    readonly patch: Partial<Omit<ProjectControlOperationRecord, "operationId" | "operationFilePath">>;
}): Promise<ProjectControlOperationRecord>;
export declare function startProjectControlOperationRunner(input: {
    readonly operationFilePath: string;
    readonly cwd?: string;
    readonly cliPath?: string;
}): Promise<{
    readonly pid: number;
    readonly command: readonly string[];
}>;
export declare function runProjectControlOperationFile(input: {
    readonly operationFilePath: string;
    readonly invokeTool: (toolName: ProjectControlOperationToolName, args: JsonRecord) => Promise<unknown>;
}): Promise<ProjectControlOperationRunResult>;
export declare function projectControlOperationView(input: {
    readonly operation: ProjectControlOperationRecord;
    readonly includeResult?: boolean;
}): ProjectControlOperationView;
export declare function projectControlOperationExecutionMode(value: unknown): "sync" | "bounded";
//# sourceMappingURL=project-control-operation-lifecycle.d.ts.map