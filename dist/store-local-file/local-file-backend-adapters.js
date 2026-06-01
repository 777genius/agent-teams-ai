import { LocalEncryptedFileStore } from "./local-encrypted-file-store.js";
import { LocalFileLeaseStore } from "./local-file-lease-store.js";
export function createLocalFileBackendRuntimeAdapters(options) {
    const encryptionKey = typeof options.encryptionKey === "string"
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
export function decodeLocalFileBackendEncryptionKey(value) {
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
//# sourceMappingURL=local-file-backend-adapters.js.map