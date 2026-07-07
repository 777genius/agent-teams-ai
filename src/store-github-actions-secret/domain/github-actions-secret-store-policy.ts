import type {
  SessionArtifact,
  SessionStoreCapabilities,
} from "@vioxen/subscription-runtime/core";

export const githubActionsSecretStorageVersion = "github-actions-secret-v1";

export const githubActionsSecretDefaultContentType = "application/octet-stream";

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

export type GitHubActionsSecretSessionSettings = {
  readonly providerId: string;
  readonly providerInstanceId: string;
  readonly secretName: string;
  readonly artifactKind: SessionArtifact["kind"];
  readonly formatVersion: string;
  readonly contentType?: string;
  readonly initialGeneration?: number;
  readonly initialGenerationHash?: string;
};

export function isGitHubActionsSecretReadTarget(input: {
  readonly settings: GitHubActionsSecretSessionSettings;
  readonly providerInstanceId: string;
  readonly expectedProviderId?: string | undefined;
}): boolean {
  if (input.providerInstanceId !== input.settings.providerInstanceId) {
    return false;
  }
  if (
    input.expectedProviderId &&
    input.expectedProviderId !== input.settings.providerId
  ) {
    return false;
  }
  return true;
}
