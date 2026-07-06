import type {
  SessionArtifact,
  SessionWriteResult,
} from "@vioxen/subscription-runtime/core";
import type { GitHubRepositoryPublicKey } from "./github-secret-encryption-port";

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

export interface GitHubActionsSecretSourcePort {
  getSecretValue(input: {
    readonly secretName: string;
  }): string | undefined;
}
