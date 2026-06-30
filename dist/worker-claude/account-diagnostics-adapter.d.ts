import { type ProviderAccountDiagnosticSignal, type ProviderAccountHealthProbePort, type ProviderAccountIdentityReaderPort, type ProviderAccountInventoryItem, type ProviderAccountRegistryPort } from "../account-diagnostics/index.js";
export type ClaudeDiagnosticAccount = ProviderAccountInventoryItem<"claude"> & {
    readonly configDir?: string;
    readonly claudePath?: string;
};
export type ClaudeDiagnosticCommandRunnerInput = {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly stdin?: string;
    readonly timeoutMs?: number;
};
export type ClaudeDiagnosticCommandResult = {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut?: boolean;
};
export type ClaudeDiagnosticCommandRunner = (input: ClaudeDiagnosticCommandRunnerInput) => Promise<ClaudeDiagnosticCommandResult>;
export declare function createClaudeAccountRegistry(accounts: readonly ClaudeDiagnosticAccount[]): ProviderAccountRegistryPort<ClaudeDiagnosticAccount>;
export declare function discoverClaudeConfigAccounts(input: {
    readonly rootDir?: string;
    readonly accounts?: readonly ClaudeDiagnosticAccount[];
    readonly capacityAccountIds?: Readonly<Record<string, string>>;
    readonly claudePath?: string;
}): Promise<readonly ClaudeDiagnosticAccount[]>;
export declare function createClaudeIdentityReader(): ProviderAccountIdentityReaderPort<ClaudeDiagnosticAccount>;
export declare function createClaudeAccountHealthProbe(input?: {
    readonly runner?: ClaudeDiagnosticCommandRunner;
    readonly claudePath?: string;
}): ProviderAccountHealthProbePort<ClaudeDiagnosticAccount>;
export declare function claudeDiagnosticSignalFromProcessResult(input: {
    readonly result: ClaudeDiagnosticCommandResult;
    readonly now: Date;
    readonly source?: "health" | "live_probe";
}): ProviderAccountDiagnosticSignal;
//# sourceMappingURL=account-diagnostics-adapter.d.ts.map