import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexAccountCapacityStore } from "../application/codex-account-capacity-store";
import {
  projectControlRefillAccountNames,
  rotateProjectControlAccountNames,
} from "../codex-goal-mcp-project-accounts";

describe("project-control refill account rotation", () => {
  it("distributes sequential jobs across distinct starting accounts", () => {
    const accounts = ["account-a", "account-b", "account-c"];

    const rotations = ["job-0", "job-1", "job-2"].map((jobId) =>
      rotateProjectControlAccountNames(accounts, jobId)
    );

    expect(rotations.map(([first]) => first)).toEqual([
      "account-b",
      "account-c",
      "account-a",
    ]);
    for (const rotation of rotations) {
      expect(new Set(rotation)).toEqual(new Set(accounts));
    }
  });

  it("keeps caller order when no rotation key is available", () => {
    const accounts = ["account-a", "account-b"];

    expect(rotateProjectControlAccountNames(accounts)).toEqual(accounts);
    expect(rotateProjectControlAccountNames(accounts, "  ")).toEqual(accounts);
  });

  it("rotates only accounts allowed by the project scope", async () => {
    await expect(
      projectControlRefillAccountNames({
        requestedAccounts: ["account-a", "account-b", "account-c"],
        allowedAccountIds: ["account-a", "account-c"],
        rotationKey: "job-0",
      })
    ).resolves.toEqual(["account-c", "account-a"]);
  });

  it("returns every fallback account exactly once", () => {
    const accounts = ["account-a", "account-b", "account-c", "account-d"];
    const rotated = rotateProjectControlAccountNames(accounts, "worker-42");

    expect(rotated).toHaveLength(accounts.length);
    expect(new Set(rotated)).toEqual(new Set(accounts));
  });

  it("excludes durable quota-blocked accounts from project refill", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-refill-capacity-"));
    const authRootDir = join(root, "auth");
    try {
      await Promise.all([
        writeFakeAuth(authRootDir, "account-a"),
        writeFakeAuth(authRootDir, "account-b"),
      ]);
      codexAccountCapacityStore(authRootDir).observe({
        accountId: "account-b",
        observedAt: new Date(),
        capacity: {
          availability: "quota_exhausted",
          reason: "quota_limited",
          cooldownUntil: new Date(Date.now() + 60 * 60_000),
        },
      });

      await expect(
        projectControlRefillAccountNames({
          authRootDir,
          requestedAccounts: ["account-a", "account-b"],
          allowedAccountIds: ["account-a", "account-b"],
        }),
      ).resolves.toEqual(["account-a"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeFakeAuth(authRootDir: string, account: string): Promise<void> {
  const dir = join(authRootDir, account);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "auth.json"),
    `${JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: new Date().toISOString(),
      tokens: {
        refresh_token: `refresh-${account}`,
        access_token: `access-${account}`,
        id_token: fakeJwt({ sub: account }),
        expiry: Math.floor(Date.now() / 1000) + 3600,
      },
    })}\n`,
  );
}

function fakeJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "",
  ].join(".");
}
