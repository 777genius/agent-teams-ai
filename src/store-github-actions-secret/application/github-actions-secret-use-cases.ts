import {
  computeSessionGenerationHash,
  type SessionArtifact,
  type SessionEnvelope,
  type SessionWriteResult,
} from "@vioxen/subscription-runtime/core";
import {
  githubActionsSecretDefaultContentType,
  githubActionsSecretStorageVersion,
  isGitHubActionsSecretReadTarget,
  type GitHubActionsSecretSessionSettings,
} from "../domain/github-actions-secret-store-policy";
import { sealGitHubEncryptedSecret } from "../domain/encrypted-secret-policy";
import { assertEncryptedWritebackRequestIsNoCustody } from "../domain/no-plaintext-boundary";
import { decodeArtifactPlaintextForEncryption } from "../domain/plaintext-session-policy";
import type {
  EncryptedWritebackClient,
  EncryptedWritebackRequest,
  GitHubActionsSecretSourcePort,
  GitHubPublicKeyProvider,
} from "../ports/github-actions-secret-writeback-port";
import type { GitHubSecretEncryptionPort } from "../ports/github-secret-encryption-port";

export type ReadGitHubActionsSecretSessionInput = {
  readonly settings: GitHubActionsSecretSessionSettings;
  readonly secretValue: string | undefined;
  readonly read: {
    readonly providerInstanceId: string;
    readonly expectedProviderId?: string;
    readonly purpose?: string;
  };
};

export function readGitHubActionsSecretSession(
  input: ReadGitHubActionsSecretSessionInput,
): SessionEnvelope | null {
  if (
    !isGitHubActionsSecretReadTarget({
      settings: input.settings,
      providerInstanceId: input.read.providerInstanceId,
      expectedProviderId: input.read.expectedProviderId,
    })
  ) {
    return null;
  }

  if (!input.secretValue) {
    return null;
  }

  const artifact = createGitHubActionsSecretArtifact({
    settings: input.settings,
    value: input.secretValue,
  });
  return {
    providerInstanceId: input.settings.providerInstanceId,
    providerId: input.settings.providerId,
    artifact,
    generation: input.settings.initialGeneration ?? 1,
    generationHash:
      input.settings.initialGenerationHash ??
      computeSessionGenerationHash({ artifact }),
    storageVersion: githubActionsSecretStorageVersion,
    custody: "no-plaintext-backend",
    metadata: {
      secretName: input.settings.secretName,
    },
  };
}

export type WriteGitHubActionsSecretSessionDeps = {
  readonly publicKeyProvider: GitHubPublicKeyProvider;
  readonly secretEncryption: GitHubSecretEncryptionPort;
  readonly secretSource: GitHubActionsSecretSourcePort;
  readonly writebackClient: EncryptedWritebackClient;
};

export type WriteGitHubActionsSecretSessionInput = {
  readonly settings: GitHubActionsSecretSessionSettings;
  readonly write: {
    readonly providerInstanceId: string;
    readonly expectedGeneration: number;
    readonly nextArtifact: SessionArtifact;
    readonly idempotencyKey: string;
    readonly leaseId: string;
  };
};

export async function writeGitHubActionsSecretSession(
  deps: WriteGitHubActionsSecretSessionDeps,
  input: WriteGitHubActionsSecretSessionInput,
): Promise<SessionWriteResult> {
  if (input.write.providerInstanceId !== input.settings.providerInstanceId) {
    throw new Error("provider_instance_mismatch");
  }

  const publicKey = await deps.publicKeyProvider.getRepositoryPublicKey({
    providerInstanceId: input.write.providerInstanceId,
  });
  const plaintext = decodeArtifactPlaintextForEncryption({
    bytes: input.write.nextArtifact.bytes,
  });
  const encrypted = await deps.secretEncryption.encryptSecretValue({
    plaintext,
    publicKey,
  });
  const sealed = sealGitHubEncryptedSecret(encrypted);
  const nextGenerationHash = computeSessionGenerationHash({
    artifact: input.write.nextArtifact,
  });
  const previous = readGitHubActionsSecretSession({
    settings: input.settings,
    secretValue: deps.secretSource.getSecretValue({
      secretName: input.settings.secretName,
    }),
    read: {
      providerInstanceId: input.write.providerInstanceId,
      expectedProviderId: input.write.nextArtifact.providerId,
    },
  });
  const request: EncryptedWritebackRequest = {
    leaseId: input.write.leaseId,
    providerInstanceId: input.write.providerInstanceId,
    idempotencyKey: input.write.idempotencyKey,
    previousGenerationHash: previous?.generationHash ?? "",
    nextGenerationHash,
    encryptedValue: sealed.encryptedValue,
    keyId: sealed.keyId,
    contentType: input.write.nextArtifact.contentType,
    formatVersion: input.write.nextArtifact.formatVersion,
    artifactKind: input.write.nextArtifact.kind,
  };
  assertEncryptedWritebackRequestIsNoCustody(request);
  return deps.writebackClient.writeEncrypted(request);
}

function createGitHubActionsSecretArtifact(input: {
  readonly settings: GitHubActionsSecretSessionSettings;
  readonly value: string;
}): SessionArtifact {
  return {
    kind: input.settings.artifactKind,
    providerId: input.settings.providerId,
    formatVersion: input.settings.formatVersion,
    bytes: new TextEncoder().encode(input.value),
    contentType:
      input.settings.contentType ?? githubActionsSecretDefaultContentType,
  };
}
