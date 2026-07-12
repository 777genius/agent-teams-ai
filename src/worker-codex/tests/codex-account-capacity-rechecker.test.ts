import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentProvider,
  identityFromAuthJson,
} from "@vioxen/agent-account-observability";
import { CodexAccountCapacityRechecker } from "../application/codex-account-capacity-rechecker";

describe("CodexAccountCapacityRechecker", () => {
  it("maps app-server quota into an exact neutral capacity snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-capacity-rechecker-"));
    try {
      const authJsonPath = join(root, "auth", "account-a", "auth.json");
      await mkdir(join(root, "auth", "account-a"), { recursive: true });
      const authJson = {
        auth_mode: "chatgpt",
        last_refresh: new Date().toISOString(),
        tokens: {
          refresh_token: "refresh-secret",
          access_token: "access-secret",
          id_token: fakeJwt({ sub: "account-a" }),
          expiry: Math.floor(Date.now() / 1000) + 3600,
        },
      };
      await writeFile(authJsonPath, `${JSON.stringify(authJson)}\n`);
      const identity = identityFromAuthJson(authJson, {
        provider: AgentProvider.Codex,
        slotId: "account-a",
        authHome: join(root, "auth", "account-a"),
        authJsonPath,
      });
      const canonicalAccountId = `codex-provider:${identity.accountKeyHash}`;
      const resetAt = new Date(Date.now() + 2 * 60 * 60_000);
      const binary = join(root, "codex-limited.sh");
      const binaryScript = `#!/bin/sh
if [ "$1" = "app-server" ]; then
  while IFS= read -r line; do
    case "$line" in
      *'"method":"initialize"'*) echo '{"id":1,"result":{}}' ;;
      *'"method":"account/read"'*) echo '{"id":2,"result":{"account":{"id":"account-a"}}}' ;;
      *'"method":"account/rateLimits/read"'*)
        echo '{"id":3,"result":{"rateLimitsByLimitId":{"weekly":{"limitId":"weekly","usedPercent":100,"windowDurationMins":10080,"resetsAt":${Math.floor(resetAt.getTime() / 1000)},"rateLimitReachedType":"weekly_limit"}}}}'
        exit 0
        ;;
    esac
  done
fi
exit 1
`;
      await writeFile(binary, binaryScript);
      await chmod(binary, 0o700);

      const result = await new CodexAccountCapacityRechecker({
        accountId: "account-a",
        authJsonPath,
        codexBinaryPath: binary,
        timeoutMs: 3000,
        appServerLaunchMinIntervalMs: 0,
      }).recheck({ accountId: canonicalAccountId, now: new Date() });

      expect(result).toMatchObject({
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: new Date(Math.floor(resetAt.getTime() / 1000) * 1000),
        details: {
          provider: "codex",
          capacitySource: "codex_app_server_live_quota",
          quotaWindowKinds: "seven_day",
        },
      });
      expect(JSON.stringify(result)).not.toContain("secret");

      const identityChanged = await new CodexAccountCapacityRechecker({
        accountId: "account-a",
        authJsonPath,
        codexBinaryPath: binary,
        timeoutMs: 3000,
        appServerLaunchMinIntervalMs: 0,
      }).recheck({
        accountId: `codex-provider:${"0".repeat(64)}`,
        now: new Date(),
      });
      expect(identityChanged).toMatchObject({
        availability: "cooldown",
        reason: "quota_recheck_identity_changed",
      });

      await writeFile(authJsonPath, `${JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          refresh_token: "rotated-refresh-secret",
          access_token: "rotated-access-secret",
          expiry: Math.floor(Date.now() / 1000) + 3600,
        },
      })}\n`);
      await writeFile(
        binary,
        binaryScript.replace(
          '"account":{"id":"account-a"}',
          '"account":{}',
        ),
      );
      const identityMissing = await new CodexAccountCapacityRechecker({
        accountId: "account-a",
        authJsonPath,
        codexBinaryPath: binary,
        timeoutMs: 3000,
        appServerLaunchMinIntervalMs: 0,
      }).recheck({ accountId: canonicalAccountId, now: new Date() });
      expect(identityMissing).toMatchObject({
        availability: "cooldown",
        reason: "quota_recheck_identity_changed",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function fakeJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "",
  ].join(".");
}
