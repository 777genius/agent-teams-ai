import { describe, expect, it } from "vitest";

import { parseExternalActionContentId } from "@agent-teams-control-plane/shared";

import type { ExternalActionContentEncryptionPort } from "../ports/external-action-content-encryption.port.js";
import type { ExternalActionContentRepository } from "../ports/external-action-content.repository.js";
import type { TransactionContext } from "../ports/transaction-context.js";
import { StoreExternalActionContentUseCase } from "./store-external-action-content.use-case.js";

describe("StoreExternalActionContentUseCase", () => {
  it("stores encrypted content and does not persist plaintext", async () => {
    const stored: unknown[] = [];
    const repository: ExternalActionContentRepository = {
      findById: async () => undefined,
      shred: async () => undefined,
      storeEncrypted: async (input) => {
        stored.push(input);
        return { ciphertextSha256: input.ciphertextSha256, id: input.id };
      },
    };
    const encryption: ExternalActionContentEncryptionPort = {
      decrypt: async () => ({ plaintext: Buffer.from("unused") }),
      encrypt: async () => ({
        ciphertext: Buffer.from("ciphertext"),
        ciphertextSha256: "ciphertext-hash",
        contentAuthTag: Buffer.from("content-tag"),
        contentEncryptionAlgorithm: "AES-256-GCM",
        contentNonce: Buffer.from("content-nonce"),
        dataKeyAlgorithm: "AES-256-GCM",
        dataKeyAuthTag: Buffer.from("data-key-tag"),
        dataKeyNonce: Buffer.from("data-key-nonce"),
        encryptedDataKey: Buffer.from("encrypted-key"),
        keyRef: "key-ref",
      }),
    };
    const id = parseExternalActionContentId("content-1");
    if (!id.ok) {
      throw id.error;
    }

    const useCase = new StoreExternalActionContentUseCase(repository, encryption);
    const ref = await useCase.execute({
      context: { transactionId: "tx-1" } as TransactionContext,
      expiresAt: new Date("2026-05-26T10:20:30.000Z"),
      id: id.value,
      kind: "github-comment",
      plaintext: Buffer.from("sensitive body"),
    });

    expect(ref).toEqual({ ciphertextSha256: "ciphertext-hash", id: "content-1" });
    expect(JSON.stringify(stored)).not.toContain("sensitive body");
  });
});
