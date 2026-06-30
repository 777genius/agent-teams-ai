import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexDiagnosticSignalFromProcessResult,
  createCodexAuthJsonIdentityReader,
  type CodexDiagnosticAccount,
} from "../account-diagnostics-adapter";

describe("Codex account diagnostics adapter", () => {
  it("reads safe identity from auth.json without returning tokens", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "codex-account-diagnostics-"));
    const authJsonPath = join(tempDir, "auth.json");
    await writeFile(
      authJsonPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          refresh_token: "refresh-token-secret",
          access_token: "access-token-secret",
          id_token: fakeJwt({
            email: "zfjexamplegw@privaterelay.appleid.com",
            chatgpt_account_id: "chatgpt-account-123",
          }),
        },
      }),
      "utf8",
    );

    try {
      const result = await createCodexAuthJsonIdentityReader().readIdentity({
        account: codexAccount({ authJsonPath }),
        now: new Date("2026-06-01T00:00:00.000Z"),
      });

      expect(result.identity.safeIdentity).toContain("***");
      expect(result.identity.safeIdentity).not.toContain("zfjexamplegw");
      expect(result.identity.accountKeyHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(JSON.stringify(result)).not.toContain("refresh-token-secret");
      expect(JSON.stringify(result)).not.toContain("access-token-secret");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("classifies revoked refresh tokens as reconnect required", () => {
    expect(
      codexDiagnosticSignalFromProcessResult({
        now: new Date("2026-06-01T00:00:00.000Z"),
        result: {
          exitCode: 1,
          stdout: "",
          stderr: "refresh_token_invalidated: token_revoked",
        },
      }),
    ).toMatchObject({
      availability: "reconnect_required",
      reason: "provider_session_invalid",
      reconnectRequired: true,
    });
  });

  it("classifies usage limit as limited with reset metadata", () => {
    const signal = codexDiagnosticSignalFromProcessResult({
      now: new Date("2026-06-01T00:10:00.000Z"),
      result: {
        exitCode: 1,
        stdout: "You've hit your usage limit. Try again at 2:43 AM.",
        stderr: "",
      },
    });

    expect(signal).toMatchObject({
      availability: "limited",
      reason: "quota_limited",
      rawResetText: "2:43 AM",
    });
    expect(signal.limitResetAt?.getHours()).toBe(2);
    expect(signal.limitResetAt?.getMinutes()).toBe(43);
  });
});

function codexAccount(input: { readonly authJsonPath: string }): CodexDiagnosticAccount {
  return {
    provider: "codex",
    slotId: "account-a",
    authJsonPath: input.authJsonPath,
  };
}

function fakeJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "",
  ].join(".");
}
