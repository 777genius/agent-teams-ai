import type { WorkspaceHandle, WorkspacePort } from "@vioxen/subscription-runtime/core";
export declare class TempWorkspace implements WorkspacePort {
    private readonly prefix;
    readonly workspaceId = "temp-workspace";
    readonly capabilities: {
        workspaceId: string;
        supportsTempDir: boolean;
        supportsExistingCheckout: boolean;
        supportsContainer: boolean;
    };
    constructor(prefix?: string);
    create(): Promise<WorkspaceHandle>;
}
export declare class StableWorkerWorkspace implements WorkspacePort {
    private readonly rootDir;
    private readonly options;
    readonly workspaceId = "stable-worker-workspace";
    readonly capabilities: {
        workspaceId: string;
        supportsTempDir: boolean;
        supportsExistingCheckout: boolean;
        supportsContainer: boolean;
    };
    constructor(rootDir: string, options?: {
        readonly allowedRootDir?: string;
    });
    create(): Promise<WorkspaceHandle>;
    dispose(): Promise<void>;
}
export declare class BorrowedRunTaskWorkspace implements WorkspacePort {
    private readonly runTaskPath;
    private readonly fallbackWorkspace;
    readonly workspaceId = "borrowed-run-task-workspace";
    readonly capabilities: WorkspacePort["capabilities"];
    constructor(runTaskPath: string, fallbackWorkspace: WorkspacePort);
    create(input: {
        readonly purpose: "refresh" | "run-task";
        readonly isolation: "temp-dir" | "existing-checkout" | "container";
    }): Promise<WorkspaceHandle>;
}
//# sourceMappingURL=temp-workspace.d.ts.map