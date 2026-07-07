import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  computeSessionGenerationHash,
} from "@vioxen/subscription-runtime/core";
import {
  assertArtifactFits,
  localEncryptedFileStoreAuthTagBytes as authTagBytes,
  localEncryptedFileStoreCapabilities,
  localEncryptedFileStoreEncryptionAlgorithm as encryptionAlgorithm,
  localEncryptedFileStoreNonceBytes as nonceBytes,
  localEncryptedFileStoreStorageVersion as storageVersion,
  normalizeEncryptionKey,
} from "../domain/local-encrypted-file-store-policy";
import type {
  SessionArtifact,
  SessionEnvelope,
  SessionStorePort,
  SessionWriteResult,
} from "../ports/session-store-contracts";

export { localEncryptedFileStoreCapabilities } from "../domain/local-encrypted-file-store-policy";

export type LocalEncryptedFileStoreOptions = {
  readonly providerId: string;
  readonly rootDir: string;
  readonly encryptionKey: Uint8Array;
  readonly metadata?: Readonly<Record<string, string>>;
};

type PersistedRecord = {
  readonly storageVersion: typeof storageVersion;
  readonly providerInstanceId: string;
  readonly providerId: string;
  readonly generation: number;
  readonly generationHash: string;
  readonly artifact: {
    readonly kind: SessionArtifact["kind"];
    readonly formatVersion: string;
    readonly contentType: string;
    readonly encryptedBytes: string;
    readonly nonce: string;
    readonly authTag: string;
    readonly algorithm: typeof encryptionAlgorithm;
  };
  readonly metadata: Readonly<Record<string, string>>;
  readonly idempotency: Readonly<Record<string, IdempotencyRecord>>;
};

type IdempotencyRecord = {
  readonly generation: number;
  readonly generationHash: string;
  readonly artifactHash: string;
};

export class LocalEncryptedFileStore implements SessionStorePort {
  readonly storeId = localEncryptedFileStoreCapabilities.storeId;
  readonly custody = localEncryptedFileStoreCapabilities.custody;
  readonly capabilities = localEncryptedFileStoreCapabilities;
  private readonly encryptionKey: Buffer;

  constructor(private readonly options: LocalEncryptedFileStoreOptions) {
    this.encryptionKey = normalizeEncryptionKey(options.encryptionKey);
  }

  async read(input: {
    readonly providerInstanceId: string;
    readonly expectedProviderId?: string;
    readonly purpose?: string;
  }): Promise<SessionEnvelope | null> {
    const record = await this.readRecord(input.providerInstanceId);
    if (!record) return null;
    if (record.providerInstanceId !== input.providerInstanceId) {
      throw new Error("local_store_record_boundary_mismatch");
    }
    if (
      input.expectedProviderId &&
      input.expectedProviderId !== record.providerId
    ) {
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

  async write(input: {
    readonly providerInstanceId: string;
    readonly expectedGeneration: number;
    readonly nextArtifact: SessionArtifact;
    readonly idempotencyKey: string;
    readonly leaseId: string;
  }): Promise<SessionWriteResult> {
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

  async delete(input: {
    readonly providerInstanceId: string;
    readonly reason: string;
  }): Promise<void> {
    await rm(this.pathFor(input.providerInstanceId), { force: true });
  }

  private async readRecord(
    providerInstanceId: string,
  ): Promise<PersistedRecord | null> {
    try {
      const bytes = await readFile(this.pathFor(providerInstanceId), "utf8");
      return parseRecord(bytes);
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  private async writeRecord(
    providerInstanceId: string,
    record: PersistedRecord,
  ): Promise<void> {
    const path = this.pathFor(providerInstanceId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(tempPath, path);
  }

  private pathFor(providerInstanceId: string): string {
    return join(this.options.rootDir, `${hashText(providerInstanceId)}.json`);
  }
}

function encryptRecord(input: {
  readonly providerInstanceId: string;
  readonly providerId: string;
  readonly artifact: SessionArtifact;
  readonly generation: number;
  readonly generationHash: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly idempotency: Readonly<Record<string, IdempotencyRecord>>;
  readonly key: Buffer;
}): PersistedRecord {
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

function decryptArtifact(
  record: PersistedRecord,
  key: Buffer,
): SessionArtifact {
  if (record.artifact.algorithm !== encryptionAlgorithm) {
    throw new Error("local_store_unsupported_algorithm");
  }
  const decipher = createDecipheriv(
    encryptionAlgorithm,
    key,
    Buffer.from(record.artifact.nonce, "base64url"),
    { authTagLength: authTagBytes },
  );
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

function parseRecord(value: string): PersistedRecord {
  const parsed = JSON.parse(value) as Partial<PersistedRecord>;
  if (
    parsed.storageVersion !== storageVersion ||
    typeof parsed.providerInstanceId !== "string" ||
    typeof parsed.providerId !== "string" ||
    typeof parsed.generation !== "number" ||
    typeof parsed.generationHash !== "string" ||
    !parsed.artifact ||
    parsed.artifact.algorithm !== encryptionAlgorithm
  ) {
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

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
