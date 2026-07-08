/// <reference types="node" />
export declare function projectControlDefaultAccountNames(input: {
    readonly authRootDir?: string;
    readonly requestedAccounts: readonly string[];
    readonly allowedAccountIds: readonly string[];
}): Promise<readonly string[]>;
export declare function projectControlRefillAccountNames(input: {
    readonly authRootDir?: string;
    readonly requestedAccounts: readonly string[];
    readonly allowedAccountIds: readonly string[];
}): Promise<readonly string[]>;
//# sourceMappingURL=codex-goal-mcp-project-accounts.d.ts.map