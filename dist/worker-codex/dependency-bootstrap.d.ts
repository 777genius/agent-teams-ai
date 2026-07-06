/// <reference types="node" />
export type DependencyBootstrapMode = "off" | "preflight" | "install";
export type DependencyPackageManagerName = "pnpm" | "npm" | "yarn" | "bun";
export type DependencyPackageManager = {
    readonly name: DependencyPackageManagerName;
    readonly source: "lockfile" | "packageManager" | "fallback";
    readonly versionSpec?: string;
    readonly lockfilePath?: string;
};
export type DependencyBinaryCheck = {
    readonly name: string;
    readonly path: string;
    readonly exists: boolean;
};
export type DependencyPreflightResult = {
    readonly mode: DependencyBootstrapMode;
    readonly workspacePath: string;
    readonly packageJsonPath?: string;
    readonly packageManager?: DependencyPackageManager;
    readonly nodeModulesPath: string;
    readonly nodeModulesExists: boolean;
    readonly binaryChecks: readonly DependencyBinaryCheck[];
    readonly fingerprint?: string;
    readonly fingerprintInputs: readonly string[];
    readonly installCommand?: string;
    readonly cacheRoot?: string;
    readonly diagnosticPath?: string;
    readonly status: "off" | "not_node_project" | "ready" | "deps_missing" | "installed" | "install_failed";
    readonly warnings: readonly string[];
};
export type DependencyBootstrapInput = {
    readonly workspacePath: string;
    readonly jobRootDir?: string;
    readonly cacheRoot?: string;
    readonly mode?: DependencyBootstrapMode;
    readonly confirmInstall?: boolean;
    readonly runCommand?: (command: string, args: readonly string[], options: {
        readonly cwd: string;
        readonly timeoutMs: number;
    }) => Promise<void>;
};
export declare function runDependencyBootstrap(input: DependencyBootstrapInput): Promise<DependencyPreflightResult>;
export declare function inspectDependencyBootstrap(workspacePath: string, mode?: DependencyBootstrapMode): Promise<DependencyPreflightResult>;
export declare function defaultDependencyCacheRoot(input: {
    readonly workspacePath: string;
    readonly jobRootDir?: string;
    readonly cacheRoot?: string;
}): string | undefined;
//# sourceMappingURL=dependency-bootstrap.d.ts.map