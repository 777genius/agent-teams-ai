import { computeSessionGenerationHash, } from "@777genius/subscription-runtime/core";
import { encryptGitHubSecretValue, } from "./github-secret-encryption.js";
import { assertNoPlaintextSessionFields, assertLooksLikeGitHubSealedBox, } from "./no-plaintext-boundary.js";
export const githubActionsSecretStoreCapabilities = {
    storeId: "github-actions-secret",
    custody: "no-plaintext-backend",
    supportsRead: true,
    supportsWriteback: true,
    supportsCompareAndSwap: true,
    supportsIdempotency: true,
    supportsDelete: false,
    supportsAuditLog: false,
    supportsMetadataOnlyHealthCheck: true,
    plaintextAvailableToBackend: false,
    maxArtifactBytes: 256_000,
};
export class GitHubActionsSecretStore {
    options;
    storeId = githubActionsSecretStoreCapabilities.storeId;
    custody = githubActionsSecretStoreCapabilities.custody;
    capabilities = githubActionsSecretStoreCapabilities;
    constructor(options) {
        this.options = options;
    }
    async read(input) {
        if (input.providerInstanceId !== this.options.providerInstanceId) {
            return null;
        }
        if (input.expectedProviderId &&
            input.expectedProviderId !== this.options.providerId) {
            return null;
        }
        const value = this.options.env[this.options.secretName];
        if (!value) {
            return null;
        }
        const artifact = {
            kind: this.options.artifactKind,
            providerId: this.options.providerId,
            formatVersion: this.options.formatVersion,
            bytes: new TextEncoder().encode(value),
            contentType: this.options.contentType ?? "application/octet-stream",
        };
        return {
            providerInstanceId: this.options.providerInstanceId,
            providerId: this.options.providerId,
            artifact,
            generation: this.options.initialGeneration ?? 1,
            generationHash: this.options.initialGenerationHash ??
                computeSessionGenerationHash({ artifact }),
            storageVersion: "github-actions-secret-v1",
            custody: this.custody,
            metadata: {
                secretName: this.options.secretName,
            },
        };
    }
    async write(input) {
        if (input.providerInstanceId !== this.options.providerInstanceId) {
            throw new Error("provider_instance_mismatch");
        }
        const publicKey = await this.options.publicKeyProvider.getRepositoryPublicKey({
            providerInstanceId: input.providerInstanceId,
        });
        const plaintext = new TextDecoder().decode(input.nextArtifact.bytes);
        const encrypted = await encryptGitHubSecretValue({ plaintext, publicKey });
        const nextGenerationHash = computeSessionGenerationHash({
            artifact: input.nextArtifact,
        });
        const previous = await this.read({
            providerInstanceId: input.providerInstanceId,
            expectedProviderId: input.nextArtifact.providerId,
        });
        const request = {
            leaseId: input.leaseId,
            providerInstanceId: input.providerInstanceId,
            idempotencyKey: input.idempotencyKey,
            previousGenerationHash: previous?.generationHash ?? "",
            nextGenerationHash,
            encryptedValue: encrypted.encryptedValue,
            keyId: encrypted.keyId,
            contentType: input.nextArtifact.contentType,
            formatVersion: input.nextArtifact.formatVersion,
            artifactKind: input.nextArtifact.kind,
        };
        assertEncryptedWritebackRequestIsNoCustody(request);
        return this.options.writebackClient.writeEncrypted(request);
    }
}
export function assertEncryptedWritebackRequestIsNoCustody(request) {
    assertNoPlaintextSessionFields(request);
    assertLooksLikeGitHubSealedBox(request.encryptedValue);
}
//# sourceMappingURL=github-actions-secret-store.js.map