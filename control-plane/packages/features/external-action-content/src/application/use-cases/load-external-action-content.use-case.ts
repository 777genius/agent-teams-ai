import {
  createSafeError,
  SystemClock,
  type Clock,
} from "@agent-teams-control-plane/shared";

import {
  validateContentCanBeDispatched,
  type ExternalActionContentRef,
} from "../../domain/external-action-content.js";
import type { ExternalActionContentEncryptionPort } from "../ports/external-action-content-encryption.port.js";
import type { ExternalActionContentRepository } from "../ports/external-action-content.repository.js";

export type DecryptedExternalActionContent = Readonly<{
  ref: ExternalActionContentRef;
  plaintext: Uint8Array;
}>;

export class LoadExternalActionContentUseCase {
  public constructor(
    private readonly repository: ExternalActionContentRepository,
    private readonly encryption: ExternalActionContentEncryptionPort,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  public async execute(
    ref: ExternalActionContentRef,
  ): Promise<DecryptedExternalActionContent> {
    const content = await this.repository.findById(ref.id);
    if (content === undefined) {
      throw createSafeError({
        category: "not-found",
        code: "CONTROL_PLANE_EXTERNAL_CONTENT_NOT_FOUND",
        message: "External action content was not found.",
      });
    }

    const invalid = validateContentCanBeDispatched(content, this.clock.nowMs());
    if (invalid !== undefined) {
      throw invalid;
    }
    if (content.ciphertextSha256 !== ref.ciphertextSha256) {
      throw createSafeError({
        category: "conflict",
        code: "CONTROL_PLANE_EXTERNAL_CONTENT_INTEGRITY_MISMATCH",
        message: "External action content integrity hash does not match.",
      });
    }

    const decrypted = await this.encryption.decrypt({
      contentAuthTag: content.contentAuthTag!,
      contentEncryptionAlgorithm: content.contentEncryptionAlgorithm,
      contentNonce: content.contentNonce!,
      ciphertext: content.ciphertext!,
      ciphertextSha256: content.ciphertextSha256,
      dataKeyAlgorithm: content.dataKeyAlgorithm,
      dataKeyAuthTag: content.dataKeyAuthTag!,
      dataKeyNonce: content.dataKeyNonce!,
      encryptedDataKey: content.encryptedDataKey!,
      keyRef: content.keyRef,
    });

    return {
      plaintext: decrypted.plaintext,
      ref,
    };
  }
}
