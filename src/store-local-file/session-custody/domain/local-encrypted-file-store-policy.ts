import type {
  SessionArtifact,
  SessionStoreCapabilities,
} from "@vioxen/subscription-runtime/core";

export const localEncryptedFileStoreStorageVersion = "local-encrypted-file-store-v1";
export const localEncryptedFileStoreEncryptionAlgorithm = "aes-256-gcm";
export const localEncryptedFileStoreNonceBytes = 12;
export const localEncryptedFileStoreAuthTagBytes = 16;

export const localEncryptedFileStoreCapabilities: SessionStoreCapabilities = {
  storeId: "local-encrypted-file",
  custody: "local-only",
  supportsRead: true,
  supportsWriteback: true,
  supportsCompareAndSwap: true,
  supportsIdempotency: true,
  supportsDelete: true,
  supportsAuditLog: false,
  supportsMetadataOnlyHealthCheck: false,
  plaintextAvailableToBackend: true,
  maxArtifactBytes: 256_000,
};

export function normalizeEncryptionKey(key: Uint8Array): Buffer {
  const buffer = Buffer.from(key);
  if (buffer.byteLength !== 32) {
    throw new Error("local_store_invalid_encryption_key");
  }
  return buffer;
}

export function assertArtifactFits(artifact: SessionArtifact): void {
  if (
    artifact.bytes.byteLength >
    localEncryptedFileStoreCapabilities.maxArtifactBytes
  ) {
    throw new Error("session_artifact_too_large");
  }
}
