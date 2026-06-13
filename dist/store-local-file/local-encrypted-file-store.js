import { createCipheriv, createDecipheriv, createHash, randomBytes, } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { computeSessionGenerationHash, } from "@vioxen/subscription-runtime/core";
const storageVersion = "local-encrypted-file-store-v1";
const encryptionAlgorithm = "aes-256-gcm";
const nonceBytes = 12;
const authTagBytes = 16;
export const localEncryptedFileStoreCapabilities = {
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
export class LocalEncryptedFileStore {
    options;
    storeId = localEncryptedFileStoreCapabilities.storeId;
    custody = localEncryptedFileStoreCapabilities.custody;
    capabilities = localEncryptedFileStoreCapabilities;
    encryptionKey;
    constructor(options) {
        this.options = options;
        this.encryptionKey = normalizeEncryptionKey(options.encryptionKey);
    }
    async read(input) {
        const record = await this.readRecord(input.providerInstanceId);
        if (!record)
            return null;
        if (record.providerInstanceId !== input.providerInstanceId) {
            throw new Error("local_store_record_boundary_mismatch");
        }
        if (input.expectedProviderId &&
            input.expectedProviderId !== record.providerId) {
            return null;
        }
        const artifact = decryptArtifact(record, this.encryptionKey);
        return {
            providerInstanceId: record.providerInstanceId,
            providerId: record.providerId,
            artifact,
            generation: record.generation,
            generationHash: record.generationHash,
            storageVersion: record.storageVersion,
            custody: this.custody,
            metadata: record.metadata,
        };
    }
    async write(input) {
        assertArtifactFits(input.nextArtifact);
        if (input.nextArtifact.providerId !== this.options.providerId) {
            throw new Error("provider_id_mismatch");
        }
        const existing = await this.readRecord(input.providerInstanceId);
        if (existing && existing.providerInstanceId !== input.providerInstanceId) {
            throw new Error("local_store_record_boundary_mismatch");
        }
        const nextGenerationHash = computeSessionGenerationHash({
            artifact: input.nextArtifact,
        });
        const nextArtifactHash = hashBytes(input.nextArtifact.bytes);
        const replay = existing?.idempotency[input.idempotencyKey];
        if (replay) {
            if (replay.artifactHash !== nextArtifactHash) {
                throw new Error("idempotency_key_conflict");
            }
            return {
                status: "idempotent_replay",
                generation: replay.generation,
                generationHash: replay.generationHash,
            };
        }
        if (existing && existing.generation !== input.expectedGeneration) {
            return {
                status: "stale_generation",
                currentGeneration: existing.generation,
                currentGenerationHash: existing.generationHash,
            };
        }
        if (!existing && input.expectedGeneration !== 0) {
            return {
                status: "stale_generation",
                currentGeneration: 0,
                currentGenerationHash: "",
            };
        }
        const generation = existing ? existing.generation + 1 : 1;
        const record = encryptRecord({
            providerInstanceId: input.providerInstanceId,
            providerId: this.options.providerId,
            artifact: input.nextArtifact,
            generation,
            generationHash: nextGenerationHash,
            metadata: {
                ...(this.options.metadata ?? {}),
                leaseId: input.leaseId,
            },
            idempotency: {
                ...(existing?.idempotency ?? {}),
                [input.idempotencyKey]: {
                    generation,
                    generationHash: nextGenerationHash,
                    artifactHash: nextArtifactHash,
                },
            },
            key: this.encryptionKey,
        });
        await this.writeRecord(input.providerInstanceId, record);
        return {
            status: "accepted",
            generation,
            generationHash: nextGenerationHash,
        };
    }
    async delete(input) {
        await rm(this.pathFor(input.providerInstanceId), { force: true });
    }
    async readRecord(providerInstanceId) {
        try {
            const bytes = await readFile(this.pathFor(providerInstanceId), "utf8");
            return parseRecord(bytes);
        }
        catch (error) {
            if (isMissingFileError(error))
                return null;
            throw error;
        }
    }
    async writeRecord(providerInstanceId, record) {
        const path = this.pathFor(providerInstanceId);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
        await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, {
            mode: 0o600,
        });
        await rename(tempPath, path);
    }
    pathFor(providerInstanceId) {
        return join(this.options.rootDir, `${hashText(providerInstanceId)}.json`);
    }
}
function normalizeEncryptionKey(key) {
    const buffer = Buffer.from(key);
    if (buffer.byteLength !== 32) {
        throw new Error("local_store_invalid_encryption_key");
    }
    return buffer;
}
function assertArtifactFits(artifact) {
    if (artifact.bytes.byteLength >
        localEncryptedFileStoreCapabilities.maxArtifactBytes) {
        throw new Error("session_artifact_too_large");
    }
}
function encryptRecord(input) {
    const nonce = randomBytes(nonceBytes);
    const cipher = createCipheriv(encryptionAlgorithm, input.key, nonce, {
        authTagLength: authTagBytes,
    });
    const encrypted = Buffer.concat([
        cipher.update(Buffer.from(input.artifact.bytes)),
        cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return {
        storageVersion,
        providerInstanceId: input.providerInstanceId,
        providerId: input.providerId,
        generation: input.generation,
        generationHash: input.generationHash,
        artifact: {
            kind: input.artifact.kind,
            formatVersion: input.artifact.formatVersion,
            contentType: input.artifact.contentType,
            encryptedBytes: encrypted.toString("base64url"),
            nonce: nonce.toString("base64url"),
            authTag: authTag.toString("base64url"),
            algorithm: encryptionAlgorithm,
        },
        metadata: input.metadata,
        idempotency: input.idempotency,
    };
}
function decryptArtifact(record, key) {
    if (record.artifact.algorithm !== encryptionAlgorithm) {
        throw new Error("local_store_unsupported_algorithm");
    }
    const decipher = createDecipheriv(encryptionAlgorithm, key, Buffer.from(record.artifact.nonce, "base64url"), { authTagLength: authTagBytes });
    decipher.setAuthTag(Buffer.from(record.artifact.authTag, "base64url"));
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(record.artifact.encryptedBytes, "base64url")),
        decipher.final(),
    ]);
    return {
        kind: record.artifact.kind,
        providerId: record.providerId,
        formatVersion: record.artifact.formatVersion,
        contentType: record.artifact.contentType,
        bytes: new Uint8Array(decrypted),
    };
}
function parseRecord(value) {
    const parsed = JSON.parse(value);
    if (parsed.storageVersion !== storageVersion ||
        typeof parsed.providerInstanceId !== "string" ||
        typeof parsed.providerId !== "string" ||
        typeof parsed.generation !== "number" ||
        typeof parsed.generationHash !== "string" ||
        !parsed.artifact ||
        parsed.artifact.algorithm !== encryptionAlgorithm) {
        throw new Error("local_store_invalid_record");
    }
    return {
        storageVersion,
        providerInstanceId: parsed.providerInstanceId,
        providerId: parsed.providerId,
        generation: parsed.generation,
        generationHash: parsed.generationHash,
        artifact: parsed.artifact,
        metadata: parsed.metadata ?? {},
        idempotency: parsed.idempotency ?? {},
    };
}
function hashText(value) {
    return createHash("sha256").update(value).digest("hex");
}
function hashBytes(value) {
    return createHash("sha256").update(value).digest("hex");
}
function isMissingFileError(error) {
    return (error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT");
}
//# sourceMappingURL=local-encrypted-file-store.js.map