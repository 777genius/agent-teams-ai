import { LocalEncryptedFileStore } from "../adapters/local-encrypted-file-store";
import { LocalFileLeaseStore } from "../../session-leases/adapters/local-file-lease-store";

export type LocalFileBackendRuntimeAdaptersOptions = {
  readonly providerId: string;
  readonly rootDir: string;
  readonly encryptionKey: Uint8Array | string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly now?: () => Date;
};

export function createLocalFileBackendRuntimeAdapters(
  options: LocalFileBackendRuntimeAdaptersOptions,
): {
  readonly sessionStore: LocalEncryptedFileStore;
  readonly leaseStore: LocalFileLeaseStore;
} {
  const encryptionKey =
    typeof options.encryptionKey === "string"
      ? decodeLocalFileBackendEncryptionKey(options.encryptionKey)
      : options.encryptionKey;

  return {
    sessionStore: new LocalEncryptedFileStore({
      providerId: options.providerId,
      rootDir: options.rootDir,
      encryptionKey,
      ...(options.metadata ? { metadata: options.metadata } : {}),
    }),
    leaseStore: new LocalFileLeaseStore({
      rootDir: options.rootDir,
      ...(options.now ? { now: options.now } : {}),
    }),
  };
}

export function decodeLocalFileBackendEncryptionKey(value: string): Uint8Array {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("local_file_backend_encryption_key_required");
  }

  const candidates = [
    normalized,
    normalized.replace(/-/g, "+").replace(/_/g, "/"),
  ];

  for (const candidate of candidates) {
    const buffer = Buffer.from(candidate, "base64");
    if (buffer.byteLength === 32) {
      return new Uint8Array(buffer);
    }
  }

  throw new Error("local_file_backend_invalid_encryption_key");
}
