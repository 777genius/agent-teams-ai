/// <reference types="node" />
export declare function assertSafeGitRefName(value: string, fieldName: string): void;
export declare function assertSafeGitRemoteName(value: string, fieldName: string): void;
export declare function assertSafeGitCommitSha(value: string): void;
export declare function assertGitCurrentBranch(input: {
    readonly workspacePath: string;
    readonly branch: string;
}): Promise<void>;
export declare function execGit(args: readonly string[]): Promise<void>;
export declare function execGitStdout(args: readonly string[]): Promise<string>;
//# sourceMappingURL=codex-goal-mcp-project-git.d.ts.map