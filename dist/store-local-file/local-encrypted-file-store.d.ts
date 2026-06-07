import { type SessionArtifact, type SessionEnvelope, type SessionStoreCapabilities, type SessionStorePort, type SessionWriteResult } from "@vioxen/subscription-runtime/core";
export declare const localEncryptedFileStoreCapabilities: SessionStoreCapabilities;
export type LocalEncryptedFileStoreOptions = {
    readonly providerId: string;
    readonly rootDir: string;
    readonly encryptionKey: Uint8Array;
    readonly metadata?: Readonly<Record<string, string>>;
};
export declare class LocalEncryptedFileStore implements SessionStorePort {
    private readonly options;
    readonly storeId: string;
    readonly custody: import("@vioxen/subscription-runtime/core").CustodyMode;
    readonly capabilities: SessionStoreCapabilities;
    private readonly encryptionKey;
    constructor(options: LocalEncryptedFileStoreOptions);
    read(input: {
        readonly providerInstanceId: string;
        readonly expectedProviderId?: string;
        readonly purpose?: string;
    }): Promise<SessionEnvelope | null>;
    write(input: {
        readonly providerInstanceId: string;
        readonly expectedGeneration: number;
        readonly nextArtifact: SessionArtifact;
        readonly idempotencyKey: string;
        readonly leaseId: string;
    }): Promise<SessionWriteResult>;
    delete(input: {
        readonly providerInstanceId: string;
        readonly reason: string;
    }): Promise<void>;
    private readRecord;
    private writeRecord;
    private pathFor;
}
//# sourceMappingURL=local-encrypted-file-store.d.ts.map