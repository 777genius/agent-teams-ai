/// <reference types="node" />
export declare function nodeErrorCode(error: unknown): string | undefined;
export declare function stringArrayArg(value: unknown): readonly string[];
export declare function uniqueProjectControlStrings(values: readonly string[]): readonly string[];
export declare function pathInsideAnyProjectRoot(path: string, roots: readonly string[]): boolean;
export declare function pathInsideOrEqual(path: string, root: string): boolean;
export declare function matchesProjectControlPrefix(value: string, prefixes: readonly string[]): boolean;
//# sourceMappingURL=codex-goal-mcp-project-utils.d.ts.map