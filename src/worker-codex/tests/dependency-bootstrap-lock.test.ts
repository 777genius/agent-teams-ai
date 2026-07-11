import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withDependencyBootstrapLock } from "../dependency-bootstrap-lock";

const FINGERPRINT = "a".repeat(64);

describe("dependency bootstrap lock", () => {
  it("serializes cache hydration for the same dependency fingerprint", async () => {
    const cacheRoot = join(tmpdir(), `dependency-lock-${Date.now()}`);
    let active = 0;
    let maxActive = 0;
    const operation = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(40);
      active -= 1;
    };
    try {
      const [first, second] = await Promise.all([
        withDependencyBootstrapLock({
          cacheRoot,
          fingerprint: FINGERPRINT,
          pollIntervalMs: 5,
        }, operation),
        withDependencyBootstrapLock({
          cacheRoot,
          fingerprint: FINGERPRINT,
          pollIntervalMs: 5,
        }, operation),
      ]);

      expect(maxActive).toBe(1);
      expect(Math.max(first.waitMs, second.waitMs)).toBeGreaterThan(0);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("recovers an old lock whose owner process no longer exists", async () => {
    const cacheRoot = join(tmpdir(), `dependency-stale-lock-${Date.now()}`);
    const lockPath = join(cacheRoot, ".locks", FINGERPRINT);
    try {
      await mkdir(lockPath, { recursive: true });
      await writeFile(
        join(lockPath, "owner.json"),
        JSON.stringify({ pid: 2_147_483_647 }),
      );
      const old = new Date(Date.now() - 60_000);
      await utimes(lockPath, old, old);

      const result = await withDependencyBootstrapLock({
        cacheRoot,
        fingerprint: FINGERPRINT,
        staleAfterMs: 1,
        pollIntervalMs: 1,
      }, async () => "recovered");

      expect(result.value).toBe("recovered");
      expect(result.staleLockRecovered).toBe(true);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("recovers an old lock with an incomplete owner record", async () => {
    const cacheRoot = join(tmpdir(), `dependency-corrupt-lock-${Date.now()}`);
    const lockPath = join(cacheRoot, ".locks", FINGERPRINT);
    try {
      await mkdir(lockPath, { recursive: true });
      await writeFile(join(lockPath, "owner.json"), "not-json");
      const old = new Date(Date.now() - 60_000);
      await utimes(lockPath, old, old);

      const result = await withDependencyBootstrapLock({
        cacheRoot,
        fingerprint: FINGERPRINT,
        staleAfterMs: 1,
        pollIntervalMs: 1,
      }, async () => "recovered");

      expect(result.staleLockRecovered).toBe(true);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
