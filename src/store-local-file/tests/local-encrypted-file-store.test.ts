import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionArtifact } from "@777genius/subscription-runtime/core";
import { sessionStoreContract } from "@777genius/subscription-runtime/testing";
import {
  LocalEncryptedFileStore,
  localEncryptedFileStoreManifest,
} from "../index";

const providerInstanceId = "codex-rotating:local-dev";
const encryptionKey = new Uint8Array(32).fill(7);
const initialAuthJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    refresh_token: "initial-refresh-token",
    access_token: "initial-access-token",
    id_token: "initial-id-token",
  },
});
const refreshedAuthJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    refresh_token: "refreshed-refresh-token",
    access_token: "refreshed-access-token",
    id_token: "refreshed-id-token",
  },
});

describe("Local encrypted file store", () => {
  it("declares local-only custody and explicit plaintext availability", () => {
    expect(localEncryptedFileStoreManifest).toMatchObject({
      adapterId: "store.local-encrypted-file",
      adapterKind: "store",
      custody: "local-only",
    });
    expect(
      localEncryptedFileStoreManifest.capabilities.plaintextAvailableToBackend,
    ).toBe(true);
  });

  it("persists encrypted session bytes and reads them back", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "subscription-runtime-local-"),
    );
    const store = makeStore(rootDir);

    try {
      await store.write({
        providerInstanceId,
        expectedGeneration: 0,
        nextArtifact: makeArtifact(initialAuthJson),
        idempotencyKey: "seed",
        leaseId: "lease-seed",
      });

      const files = await readStoredFiles(rootDir);
      const serialized = files.join("\n");
      expect(serialized).not.toContain("initial-refresh-token");
      expect(serialized).not.toContain("initial-access-token");
      expect(serialized).not.toContain("initial-id-token");

      const envelope = await store.read({
        providerInstanceId,
        expectedProviderId: "codex",
        purpose: "refresh",
      });
      expect(envelope?.custody).toBe("local-only");
      expect(new TextDecoder().decode(envelope?.artifact.bytes)).toBe(
        initialAuthJson,
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects stale generations and conflicting idempotency keys", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "subscription-runtime-local-"),
    );
    const store = makeStore(rootDir);

    try {
      await store.write({
        providerInstanceId,
        expectedGeneration: 0,
        nextArtifact: makeArtifact(initialAuthJson),
        idempotencyKey: "idem-1",
        leaseId: "lease-1",
      });

      await expect(
        store.write({
          providerInstanceId,
          expectedGeneration: 0,
          nextArtifact: makeArtifact(refreshedAuthJson),
          idempotencyKey: "idem-2",
          leaseId: "lease-2",
        }),
      ).resolves.toMatchObject({ status: "stale_generation" });

      await expect(
        store.write({
          providerInstanceId,
          expectedGeneration: 1,
          nextArtifact: makeArtifact(refreshedAuthJson),
          idempotencyKey: "idem-1",
          leaseId: "lease-3",
        }),
      ).rejects.toThrow("idempotency_key_conflict");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("deletes local session files", async () => {
    const rootDir = await mkdtemp(
      join(tmpdir(), "subscription-runtime-local-"),
    );
    const store = makeStore(rootDir);

    try {
      await store.write({
        providerInstanceId,
        expectedGeneration: 0,
        nextArtifact: makeArtifact(initialAuthJson),
        idempotencyKey: "seed",
        leaseId: "lease-seed",
      });
      await store.delete?.({ providerInstanceId, reason: "test-cleanup" });

      await expect(
        store.read({
          providerInstanceId,
          expectedProviderId: "codex",
          purpose: "health-check",
        }),
      ).resolves.toBeNull();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

sessionStoreContract("local encrypted file store", () => {
  const fixtureId = `${providerInstanceId}:${Math.random().toString(16).slice(2)}`;
  const rootDir = mkdtempSync(join(tmpdir(), "subscription-runtime-local-"));
  const store = makeStore(rootDir);

  return {
    store,
    providerInstanceId: fixtureId,
    currentArtifact: makeArtifact(initialAuthJson),
    nextArtifact: makeArtifact(refreshedAuthJson),
    async seed(input: { readonly generation: number }) {
      if (input.generation <= 0) return;
      await store.write({
        providerInstanceId: fixtureId,
        expectedGeneration: 0,
        nextArtifact: makeArtifact(initialAuthJson),
        idempotencyKey: "seed",
        leaseId: "lease-seed",
      });
      for (let generation = 1; generation < input.generation; generation += 1) {
        await store.write({
          providerInstanceId: fixtureId,
          expectedGeneration: generation,
          nextArtifact: makeArtifact(`${refreshedAuthJson}:${generation}`),
          idempotencyKey: `seed-${generation}`,
          leaseId: `lease-seed-${generation}`,
        });
      }
    },
  };
});

function makeStore(rootDir: string): LocalEncryptedFileStore {
  return new LocalEncryptedFileStore({
    providerId: "codex",
    rootDir,
    encryptionKey,
    metadata: { environment: "test" },
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

async function readStoredFiles(rootDir: string): Promise<readonly string[]> {
  const { readdir } = await import("node:fs/promises");
  const fileNames = await readdir(rootDir);
  return Promise.all(
    fileNames.map((fileName) => readFile(join(rootDir, fileName), "utf8")),
  );
}
