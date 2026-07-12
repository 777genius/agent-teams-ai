import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexAccountCapacityStore } from "../application/codex-account-capacity-store";
import { listCodexGoalAccountStatuses } from "../codex-goal-account-status";

describe("Codex goal account status", () => {
  it("reads Codex app-server quota limits during live account status", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-goal-account-status-"));
    try {
      const authRootDir = join(root, "auth");
      await mkdir(join(authRootDir, "account-a"), { recursive: true });
      await writeFile(
        join(authRootDir, "account-a", "auth.json"),
        `${JSON.stringify({
          auth_mode: "chatgpt",
          last_refresh: new Date().toISOString(),
          tokens: {
            refresh_token: "refresh-secret",
            access_token: "access-secret",
            id_token: fakeJwt({
              email: "secret@example.com",
              sub: "oauth-sub-secret",
              "https://api.openai.com/auth": {
                chatgpt_account_id: "chatgpt-account-secret",
              },
            }),
            expiry: Math.floor(Date.now() / 1000) + 3600,
          },
        })}\n`,
      );

      const codexLimited = join(root, "codex-limited.sh");
      const resetEpochSeconds = Math.floor(
        (Date.now() + 3 * 60 * 60 * 1000) / 1000,
      );
      await writeFile(
        codexLimited,
        `#!/bin/sh
if [ "$1" = "app-server" ]; then
  while IFS= read -r line; do
    case "$line" in
      *'"method":"initialize"'*)
        echo '{"id":1,"result":{}}'
        ;;
      *'"method":"account/read"'*)
        echo '{"id":2,"result":{"account":{"id":"chatgpt-account-secret","email":"operator@example.com"}}}'
        ;;
      *'"method":"account/rateLimits/read"'*)
        echo '{"id":3,"result":{"rateLimitsByLimitId":{"codex":{"limitId":"codex","usedPercent":100,"windowDurationMins":300,"resetsAt":${resetEpochSeconds},"rateLimitReachedType":"five_hour_limit"}}}}'
        exit 0
        ;;
    esac
  done
fi
echo 'fallback should not run secret@example.com' >&2
exit 1
`,
      );
      await chmod(codexLimited, 0o700);
      const accounts = await listCodexGoalAccountStatuses({
        authRootDir,
        accounts: ["account-a"],
        liveCheck: true,
        codexBinaryPath: codexLimited,
        liveCheckTimeoutMs: 1000,
      });

      const reset = new Date(resetEpochSeconds * 1000).toISOString();
      expect(accounts[0]).toMatchObject({
        status: "ready",
        availability: "limited",
        schedulerEligible: false,
        recommendedAction: "wait",
        limitResetAt: reset,
        liveCheck: "passed",
        liveCheckSafeMessage: `codex account is quota limited until ${reset}`,
      });
      expect(JSON.stringify(accounts)).not.toContain("secret@example.com");

      const capacity = codexAccountCapacityStore(authRootDir).read({
        accountId: "account-a",
      });
      expect(capacity).toMatchObject({
        availability: "quota_exhausted",
        reason: "quota_limited",
        cooldownUntil: new Date(reset),
        details: {
          accountId: expect.stringMatching(/^codex-provider:[a-f0-9]{64}$/),
          provider: "codex",
          capacitySource: "codex_app_server_live_quota",
          quotaWindowKinds: "five_hour",
        },
      });

      const cachedAccounts = await listCodexGoalAccountStatuses({
        authRootDir,
        accounts: ["account-a"],
      });
      expect(cachedAccounts[0]).toMatchObject({
        availability: "limited",
        schedulerEligible: false,
        capacityAvailability: "quota_exhausted",
        capacityReason: "quota_limited",
        capacityCooldownUntil: reset,
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
