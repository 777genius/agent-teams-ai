import { type SessionArtifact, type SessionEnvelope, type SessionStoreCapabilities, type SessionStorePort, type SessionWriteResult } from "@777genius/subscription-runtime/core";
import { type GitHubRepositoryPublicKey } from "./github-secret-encryption";
export type EncryptedWritebackRequest = {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly idempotencyKey: string;
    readonly previousGenerationHash: string;
    readonly nextGenerationHash: string;
    readonly encryptedValue: string;
    readonly keyId: string;
    readonly contentType: string;
    readonly formatVersion: string;
    readonly artifactKind: SessionArtifact["kind"];
};
export interface GitHubPublicKeyProvider {
    getRepositoryPublicKey(input: {
        readonly providerInstanceId: string;
    }): Promise<GitHubRepositoryPublicKey>;
}
export interface EncryptedWritebackClient {
    writeEncrypted(input: EncryptedWritebackRequest): Promise<SessionWriteResult>;
}
export declare const githubActionsSecretStoreCapabilities: SessionStoreCapabilities;
export type GitHubActionsSecretStoreOptions = {
    readonly providerId: string;
    readonly providerInstanceId: string;
    readonly secretName: string;
    readonly artifactKind: SessionArtifact["kind"];
    readonly formatVersion: string;
    readonly contentType?: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly initialGeneration?: number;
    readonly initialGenerationHash?: string;
    readonly publicKeyProvider: GitHubPublicKeyProvider;
    readonly writebackClient: EncryptedWritebackClient;
};
export declare class GitHubActionsSecretStore implements SessionStorePort {
    private readonly options;
    readonly storeId: string;
    readonly custody: import("@777genius/subscription-runtime/core").CustodyMode;
    readonly capabilities: SessionStoreCapabilities;
    constructor(options: GitHubActionsSecretStoreOptions);
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
}
export declare function assertEncryptedWritebackRequestIsNoCustody(request: EncryptedWritebackRequest): void;
//# sourceMappingURL=github-actions-secret-store.d.ts.map