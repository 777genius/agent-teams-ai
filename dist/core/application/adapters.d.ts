import type { AgentCapabilities, ProviderCapabilities, RuntimePolicy, RunnerCapabilities, SessionStoreCapabilities } from "../domain/types";
export declare const subscriptionRuntimeCoreVersion = "0.0.0";
export declare const subscriptionRuntimeProtocolVersion = 1;
export type RuntimeAdapterKind = "provider-session" | "agent" | "combined-provider" | "store" | "lease-store" | "runner" | "workspace" | "setup" | "observability";
export type RuntimeAdapterManifest<TCapabilities = unknown> = {
    readonly adapterId: string;
    readonly adapterKind: RuntimeAdapterKind;
    readonly packageName: string;
    readonly packageVersion: string;
    readonly protocolVersion: 1;
    readonly capabilities: TCapabilities;
    readonly custody?: "no-plaintext-backend" | "backend-custody" | "local-only";
    readonly experimental: boolean;
    readonly minimumCoreVersion: string;
};
export type RuntimeAdapterFactory<TPort = unknown, TOptions = unknown> = {
    readonly manifest: RuntimeAdapterManifest;
    create(options: TOptions): TPort;
};
export type AdapterRegistry = {
    register(adapter: RuntimeAdapterFactory): void;
    getManifest(adapterId: string): RuntimeAdapterManifest | null;
    create<TPort = unknown, TOptions = unknown>(adapterId: string, options: TOptions): TPort;
};
export declare function createAdapterRegistry(adapters?: readonly RuntimeAdapterFactory[]): AdapterRegistry;
export declare function assertRuntimeAdapterManifest(manifest: RuntimeAdapterManifest, coreVersion?: string): void;
export declare function assertCompatibleRuntimeManifests(input: {
    readonly provider: RuntimeAdapterManifest<{
        readonly session?: ProviderCapabilities;
        readonly agent?: AgentCapabilities;
    }>;
    readonly store?: RuntimeAdapterManifest<SessionStoreCapabilities>;
    readonly runner: RuntimeAdapterManifest<RunnerCapabilities>;
    readonly policy: RuntimePolicy;
    readonly coreVersion?: string;
}): void;
export declare function defineSubscriptionRuntimeConfig<TConfig extends Readonly<Record<string, unknown>>>(config: TConfig): TConfig;
export declare function assertNoSessionBytesInConfig(value: unknown): void;
//# sourceMappingURL=adapters.d.ts.map