#!/usr/bin/env node
import { type ListProviderAccountDiagnosticsDependencies, type ProviderAccountAvailability, type ProviderAccountProbeMode, type ProviderAccountProviderId } from "../account-diagnostics/index.js";
type ProviderSelector = ProviderAccountProviderId | "all";
export type AccountDiagnosticsCliIo = {
    writeStdout(chunk: string): void;
    writeStderr(chunk: string): void;
    cwd(): string;
    env(): Readonly<Record<string, string | undefined>>;
};
export type AccountDiagnosticsProviderFactoryInput = {
    readonly provider: ProviderAccountProviderId;
    readonly args: AccountDiagnosticsCliParsedArgs;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly cwd: string;
};
export type AccountDiagnosticsProviderFactory = (input: AccountDiagnosticsProviderFactoryInput) => Promise<ListProviderAccountDiagnosticsDependencies>;
export type AccountDiagnosticsCliDependencies = {
    readonly providerFactory?: AccountDiagnosticsProviderFactory;
};
export type AccountDiagnosticsCliParsedArgs = {
    readonly provider: ProviderSelector;
    readonly json: boolean;
    readonly probeMode: ProviderAccountProbeMode;
    readonly only?: readonly ProviderAccountAvailability[];
    readonly timeoutMs?: number;
    readonly maxConcurrency?: number;
    readonly codexHomeRoot?: string;
    readonly codexAccounts: readonly string[];
    readonly codexBinaryPath?: string;
    readonly claudeConfigRoot?: string;
    readonly claudeAccounts: readonly string[];
    readonly claudePath?: string;
    readonly accountCapacityRoot?: string;
    readonly capacityAccounts: readonly string[];
};
export declare function runAccountDiagnosticsCli(argv?: string[], io?: AccountDiagnosticsCliIo, dependencies?: AccountDiagnosticsCliDependencies): Promise<number>;
export {};
//# sourceMappingURL=account-diagnostics-cli.d.ts.map