import type { WorkspaceHandle, WorkspacePort } from "@777genius/subscription-runtime/core";
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
    readonly workspaceId = "stable-worker-workspace";
    readonly capabilities: {
        workspaceId: string;
        supportsTempDir: boolean;
        supportsExistingCheckout: boolean;
        supportsContainer: boolean;
    };
    constructor(rootDir: string);
    create(): Promise<WorkspaceHandle>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=temp-workspace.d.ts.map