import { describe, expect, it, vi } from "vitest";

import {
  FixedClock,
  parseExternalActionContentId,
  toUnixMilliseconds,
} from "@agent-teams-control-plane/shared";

import type { ExternalActionContentEncryptionPort } from "../ports/external-action-content-encryption.port.js";
import type { ExternalActionContentRepository } from "../ports/external-action-content.repository.js";
import { LoadExternalActionContentUseCase } from "./load-external-action-content.use-case.js";

describe("LoadExternalActionContentUseCase", () => {
  it("rejects refs whose integrity hash does not match stored ciphertext", async () => {
    const id = parseExternalActionContentId("content-1");
    if (!id.ok) {
      throw id.error;
    }
    const decrypt = vi.fn<ExternalActionContentEncryptionPort["decrypt"]>();
    const repository: ExternalActionContentRepository = {
      findById: async () => ({
        ciphertext: Buffer.from("ciphertext"),
        ciphertextSha256: "stored-hash",
        contentAuthTag: Buffer.from("content-tag"),
        contentEncryptionAlgorithm: "AES-256-GCM",
        contentNonce: Buffer.from("content-nonce"),
        createdAtMs: toUnixMilliseconds(0),
        dataKeyAlgorithm: "AES-256-GCM",
        dataKeyAuthTag: Buffer.from("data-key-tag"),
        dataKeyNonce: Buffer.from("data-key-nonce"),
        encryptedDataKey: Buffer.from("encrypted-key"),
        expiresAtMs: toUnixMilliseconds(2_000),
        id: id.value,
        keyRef: "key-ref",
        kind: "github-comment",
      }),
      shred: async () => undefined,
      storeEncrypted: async () => {
        throw new Error("unused");
      },
    };
    const encryption: ExternalActionContentEncryptionPort = {
      decrypt,
      encrypt: async () => {
        throw new Error("unused");
      },
    };
    const useCase = new LoadExternalActionContentUseCase(
      repository,
      encryption,
      new FixedClock(toUnixMilliseconds(1_000)),
    );

    await expect(
      useCase.execute({ ciphertextSha256: "ref-hash", id: id.value }),
    ).rejects.toMatchObject({
      code: "CONTROL_PLANE_EXTERNAL_CONTENT_INTEGRITY_MISMATCH",
    });
    expect(decrypt).not.toHaveBeenCalled();
  });
});
