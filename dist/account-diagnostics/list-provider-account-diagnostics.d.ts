import type { ListProviderAccountDiagnosticsDependencies, ListProviderAccountDiagnosticsOptions, ListProviderAccountDiagnosticsResult, ProviderAccountInventoryItem } from "./types.js";
export declare class ListProviderAccountDiagnostics<Account extends ProviderAccountInventoryItem = ProviderAccountInventoryItem> {
    private readonly dependencies;
    constructor(dependencies: ListProviderAccountDiagnosticsDependencies<Account>);
    execute(options?: ListProviderAccountDiagnosticsOptions): Promise<ListProviderAccountDiagnosticsResult>;
    private diagnoseAccount;
    private readProbeSignal;
}
//# sourceMappingURL=list-provider-account-diagnostics.d.ts.map