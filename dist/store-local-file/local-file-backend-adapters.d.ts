import { LocalEncryptedFileStore } from "./local-encrypted-file-store";
import { LocalFileLeaseStore } from "./local-file-lease-store";
export type LocalFileBackendRuntimeAdaptersOptions = {
    readonly providerId: string;
    readonly rootDir: string;
    readonly encryptionKey: Uint8Array | string;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly now?: () => Date;
};
export declare function createLocalFileBackendRuntimeAdapters(options: LocalFileBackendRuntimeAdaptersOptions): {
    readonly sessionStore: LocalEncryptedFileStore;
    readonly leaseStore: LocalFileLeaseStore;
};
export declare function decodeLocalFileBackendEncryptionKey(value: string): Uint8Array;
//# sourceMappingURL=local-file-backend-adapters.d.ts.map