import type { ProviderAccountProviderId } from "./types.js";
export declare function hashProviderAccountKey(input: {
    readonly provider: ProviderAccountProviderId;
    readonly accountKey: string;
}): string | undefined;
export declare function shortAccountHash(accountKeyHash: string | undefined): string;
export declare function normalizeAccountKey(value: string | null | undefined): string;
export declare function maskEmail(value: string): string;
//# sourceMappingURL=identity.d.ts.map