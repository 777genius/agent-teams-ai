import { type ProviderAccountDiagnosticSignal, type ProviderAccountHealthProbePort, type ProviderAccountIdentityReaderPort, type ProviderAccountInventoryItem, type ProviderAccountRegistryPort } from "../account-diagnostics/index.js";
export type CodexDiagnosticAccount = ProviderAccountInventoryItem<"codex"> & {
    readonly authJsonPath: string;
    readonly codexHome?: string;
    readonly codexBinaryPath?: string;
};
export type CodexDiagnosticCommandRunnerInput = {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly stdin?: string;
    readonly timeoutMs?: number;
};
export type CodexDiagnosticCommandResult = {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut?: boolean;
};
export type CodexDiagnosticCommandRunner = (input: CodexDiagnosticCommandRunnerInput) => Promise<CodexDiagnosticCommandResult>;
export declare function createCodexAccountRegistry(accounts: readonly CodexDiagnosticAccount[]): ProviderAccountRegistryPort<CodexDiagnosticAccount>;
export declare function discoverCodexAuthJsonAccounts(input: {
    readonly rootDir?: string;
    readonly accounts?: readonly CodexDiagnosticAccount[];
    readonly capacityAccountIds?: Readonly<Record<string, string>>;
    readonly codexBinaryPath?: string;
}): Promise<readonly CodexDiagnosticAccount[]>;
export declare function createCodexAuthJsonIdentityReader(): ProviderAccountIdentityReaderPort<CodexDiagnosticAccount>;
export declare function createCodexAccountHealthProbe(input?: {
    readonly runner?: CodexDiagnosticCommandRunner;
    readonly codexBinaryPath?: string;
}): ProviderAccountHealthProbePort<CodexDiagnosticAccount>;
export declare function codexDiagnosticSignalFromProcessResult(input: {
    readonly result: CodexDiagnosticCommandResult;
    readonly now: Date;
    readonly source?: "health" | "live_probe";
}): ProviderAccountDiagnosticSignal;
//# sourceMappingURL=account-diagnostics-adapter.d.ts.map