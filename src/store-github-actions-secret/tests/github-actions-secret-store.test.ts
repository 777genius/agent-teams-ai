import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import {
  BoundaryViolationError,
  computeSessionGenerationHash,
  type SessionArtifact,
  type SessionWriteResult,
} from "@vioxen/subscription-runtime/core";
import { writeGitHubActionsSecretSession } from "../application";
import {
  GitHubActionsSecretStore,
  assertEncryptedWritebackRequestIsNoCustody,
  assertNoPlaintextSessionFields,
  encryptGitHubSecretValue,
  githubActionsSecretStoreManifest,
  type EncryptedWritebackRequest,
  type GitHubSecretEncryptionPort,
  type GitHubRepositoryPublicKey,
} from "../index";

const tokenField = "token";
const refreshTokenField = ["refresh", tokenField].join("_");
const accessTokenField = ["access", tokenField].join("_");
const initialRefreshToken = ["initial", "refresh", tokenField].join("-");
const initialAccessToken = ["initial", "access", tokenField].join("-");
const refreshedRefreshToken = ["refreshed", "refresh", tokenField].join("-");
const refreshedAccessToken = ["refreshed", "access", tokenField].join("-");
const rawToken = ["raw", tokenField].join("-");
const secretName = ["REVIEWROUTER", "CODEX", "AUTH", "JSON"].join("_");

const authJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    [refreshTokenField]: initialRefreshToken,
    [accessTokenField]: initialAccessToken,
  },
});

const refreshedAuthJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    [refreshTokenField]: refreshedRefreshToken,
    [accessTokenField]: refreshedAccessToken,
  },
});

describe("GitHub Actions Secret store", () => {
  it("declares a no-custody store manifest", () => {
    expect(githubActionsSecretStoreManifest).toMatchObject({
      adapterId: "store.github-actions-secret",
      adapterKind: "store",
      custody: "no-plaintext-backend",
    });
    expect(
      githubActionsSecretStoreManifest.capabilities.plaintextAvailableToBackend,
    ).toBe(false);
  });

  it("reads exact runner secret bytes as a no-custody session envelope", async () => {
    const store = makeStore();

    const envelope = await store.read({
      providerInstanceId: "codex-rotating:repo",
      expectedProviderId: "codex",
      purpose: "refresh",
    });

    expect(envelope?.custody).toBe("no-plaintext-backend");
    expect(new TextDecoder().decode(envelope?.artifact.bytes)).toBe(authJson);
    expect(envelope?.generationHash).toBe(
      computeSessionGenerationHash({ artifact: envelope!.artifact }),
    );
  });

  it("encrypts writeback and sends no plaintext to the client boundary", async () => {
    const writeback = new CapturingWritebackClient();
    const store = makeStore({ writebackClient: writeback });

    const result = await store.write({
      providerInstanceId: "codex-rotating:repo",
      expectedGeneration: 1,
      nextArtifact: makeArtifact(refreshedAuthJson),
      idempotencyKey: "idem-1",
      leaseId: "lease-1",
    });

    expect(result.status).toBe("accepted");
    expect(writeback.lastRequest).toBeTruthy();
    const serialized = JSON.stringify(writeback.lastRequest);
    expect(serialized).not.toContain(refreshedRefreshToken);
    expect(serialized).not.toContain(refreshedAccessToken);
    expect(writeback.lastRequest?.encryptedValue).not.toContain(
      refreshedRefreshToken,
    );
  });

  it("orchestrates writeback through application ports without exposing plaintext", async () => {
    const writeback = new CapturingWritebackClient();
    const encryptedValue = "B".repeat(128);
    const plaintexts: string[] = [];
    const secretEncryption: GitHubSecretEncryptionPort = {
      encryptSecretValue: async ({ plaintext, publicKey }) => {
        plaintexts.push(plaintext);
        return {
          encryptedValue,
          keyId: publicKey.keyId,
        };
      },
    };

    const result = await writeGitHubActionsSecretSession(
      {
        publicKeyProvider: {
          getRepositoryPublicKey: async () => ({
            key: "unused-by-fake-encryption",
            keyId: "fake-key",
          }),
        },
        secretEncryption,
        secretSource: {
          getSecretValue: () => authJson,
        },
        writebackClient: writeback,
      },
      {
        settings: {
          providerId: "codex",
          providerInstanceId: "codex-rotating:repo",
          secretName: secretName,
          artifactKind: "json-file",
          formatVersion: "codex-auth-json-v1",
          contentType: "application/json",
        },
        write: {
          providerInstanceId: "codex-rotating:repo",
          expectedGeneration: 1,
          nextArtifact: makeArtifact(refreshedAuthJson),
          idempotencyKey: "idem-1",
          leaseId: "lease-1",
        },
      },
    );

    expect(result.status).toBe("accepted");
    expect(plaintexts).toEqual([refreshedAuthJson]);
    expect(writeback.lastRequest).toMatchObject({
      encryptedValue,
      keyId: "fake-key",
      previousGenerationHash: computeSessionGenerationHash({
        artifact: makeArtifact(authJson),
      }),
      nextGenerationHash: computeSessionGenerationHash({
        artifact: makeArtifact(refreshedAuthJson),
      }),
    });
    expect(JSON.stringify(writeback.lastRequest)).not.toContain(
      refreshedRefreshToken,
    );
    expect(JSON.stringify(writeback.lastRequest)).not.toContain(
      refreshedAccessToken,
    );
  });

  it("rejects plaintext-looking writeback requests at the no-custody boundary", () => {
    const request: EncryptedWritebackRequest & Readonly<Record<typeof refreshTokenField, string>> = {
      leaseId: "lease-1",
      providerInstanceId: "codex-rotating:repo",
      idempotencyKey: "idem-1",
      previousGenerationHash: "old",
      nextGenerationHash: "new",
      encryptedValue: "a".repeat(128),
      keyId: "key-1",
      contentType: "application/json",
      formatVersion: "codex-auth-json-v1",
      artifactKind: "json-file",
      [refreshTokenField]: rawToken,
    };

    expect(() => assertNoPlaintextSessionFields(request)).toThrow(
      BoundaryViolationError,
    );
  });

  it("encrypts with GitHub sealed box format", async () => {
    const keyPair = await makePublicKey();
    const encrypted = await encryptGitHubSecretValue({
      plaintext: refreshedAuthJson,
      publicKey: keyPair.publicKey,
    });

    expect(encrypted.keyId).toBe("key-1");
    expect(encrypted.encryptedValue).not.toContain(refreshedRefreshToken);
    expect(() =>
      assertEncryptedWritebackRequestIsNoCustody({
        leaseId: "lease-1",
        providerInstanceId: "codex-rotating:repo",
        idempotencyKey: "idem-1",
        previousGenerationHash: "old",
        nextGenerationHash: "new",
        encryptedValue: encrypted.encryptedValue,
        keyId: encrypted.keyId,
        contentType: "application/json",
        formatVersion: "codex-auth-json-v1",
        artifactKind: "json-file",
      }),
    ).not.toThrow();
  });
});

function makeStore(
  input: {
    readonly writebackClient?: CapturingWritebackClient;
  } = {},
) {
  const writebackClient =
    input.writebackClient ?? new CapturingWritebackClient();
  return new GitHubActionsSecretStore({
    providerId: "codex",
    providerInstanceId: "codex-rotating:repo",
    secretName: secretName,
    artifactKind: "json-file",
    formatVersion: "codex-auth-json-v1",
    contentType: "application/json",
    env: {
      [secretName]: authJson,
    },
    publicKeyProvider: {
      getRepositoryPublicKey: async () => (await makePublicKey()).publicKey,
    },
    writebackClient,
  });
}

function makeArtifact(value: string): SessionArtifact {
  return {
    kind: "json-file",
    providerId: "codex",
    formatVersion: "codex-auth-json-v1",
    bytes: new TextEncoder().encode(value),
    contentType: "application/json",
  };
}

async function makePublicKey(): Promise<{
  readonly publicKey: GitHubRepositoryPublicKey;
}> {
  await sodium.ready;
  const keyPair = sodium.crypto_box_keypair();
  return {
    publicKey: {
      key: sodium.to_base64(keyPair.publicKey, sodium.base64_variants.ORIGINAL),
      keyId: "key-1",
    },
  };
}

class CapturingWritebackClient {
  lastRequest: EncryptedWritebackRequest | null = null;

  async writeEncrypted(
    input: EncryptedWritebackRequest,
  ): Promise<SessionWriteResult> {
    this.lastRequest = input;
    return {
      status: "accepted",
      generation: 2,
      generationHash: input.nextGenerationHash,
    };
  }
}
