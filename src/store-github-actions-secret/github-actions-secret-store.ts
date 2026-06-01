import {
  computeSessionGenerationHash,
  type SessionArtifact,
  type SessionEnvelope,
  type SessionStoreCapabilities,
  type SessionStorePort,
  type SessionWriteResult,
} from "@777genius/subscription-runtime/core";
import {
  encryptGitHubSecretValue,
  type GitHubRepositoryPublicKey,
} from "./github-secret-encryption";
import {
  assertNoPlaintextSessionFields,
  assertLooksLikeGitHubSealedBox,
} from "./no-plaintext-boundary";

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

export const githubActionsSecretStoreCapabilities: SessionStoreCapabilities = {
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

export class GitHubActionsSecretStore implements SessionStorePort {
  readonly storeId = githubActionsSecretStoreCapabilities.storeId;
  readonly custody = githubActionsSecretStoreCapabilities.custody;
  readonly capabilities = githubActionsSecretStoreCapabilities;

  constructor(private readonly options: GitHubActionsSecretStoreOptions) {}

  async read(input: {
    readonly providerInstanceId: string;
    readonly expectedProviderId?: string;
    readonly purpose?: string;
  }): Promise<SessionEnvelope | null> {
    if (input.providerInstanceId !== this.options.providerInstanceId) {
      return null;
    }
    if (
      input.expectedProviderId &&
      input.expectedProviderId !== this.options.providerId
    ) {
      return null;
    }

    const value = this.options.env[this.options.secretName];
    if (!value) {
      return null;
    }

    const artifact: SessionArtifact = {
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
      generationHash:
        this.options.initialGenerationHash ??
        computeSessionGenerationHash({ artifact }),
      storageVersion: "github-actions-secret-v1",
      custody: this.custody,
      metadata: {
        secretName: this.options.secretName,
      },
    };
  }

  async write(input: {
    readonly providerInstanceId: string;
    readonly expectedGeneration: number;
    readonly nextArtifact: SessionArtifact;
    readonly idempotencyKey: string;
    readonly leaseId: string;
  }): Promise<SessionWriteResult> {
    if (input.providerInstanceId !== this.options.providerInstanceId) {
      throw new Error("provider_instance_mismatch");
    }

    const publicKey =
      await this.options.publicKeyProvider.getRepositoryPublicKey({
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
    const request: EncryptedWritebackRequest = {
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

export function assertEncryptedWritebackRequestIsNoCustody(
  request: EncryptedWritebackRequest,
): void {
  assertNoPlaintextSessionFields(request);
  assertLooksLikeGitHubSealedBox(request.encryptedValue);
}
