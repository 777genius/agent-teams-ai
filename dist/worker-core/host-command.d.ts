export type HostExecutableResolutionSource = "env" | "path" | "candidate" | "unresolved";
export type HostExecutableResolution = {
    readonly name: string;
    readonly executable: string;
    readonly found: boolean;
    readonly source: HostExecutableResolutionSource;
    readonly sourceName?: string;
    readonly checked: readonly string[];
};
export type HostExecutableLookup = {
    readonly name: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly envNames?: readonly string[];
    readonly additionalCandidates?: readonly string[];
};
export declare function resolveHostExecutable(input: HostExecutableLookup): Promise<HostExecutableResolution>;
export declare function hostExecutableNotFoundMessage(resolution: HostExecutableResolution): string;
//# sourceMappingURL=host-command.d.ts.map