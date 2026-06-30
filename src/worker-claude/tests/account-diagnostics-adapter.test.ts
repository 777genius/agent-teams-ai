import { describe, expect, it } from "vitest";
import {
  claudeDiagnosticSignalFromProcessResult,
  createClaudeIdentityReader,
  type ClaudeDiagnosticAccount,
} from "../account-diagnostics-adapter";

describe("Claude account diagnostics adapter", () => {
  it("uses capacity account id as the stable diagnostic identity", async () => {
    const result = await createClaudeIdentityReader().readIdentity({
      account: claudeAccount({
        capacityAccountId: "claude-oauth:account-a",
      }),
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(result.identity.safeIdentity).toMatch(/^claude:[a-f0-9]{10}$/);
    expect(result.identity.accountKeyHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.identity.providerAccountId).toBe("claude-oauth:account-a");
  });

  it("classifies OAuth failures as reconnect required", () => {
    expect(
      claudeDiagnosticSignalFromProcessResult({
        now: new Date("2026-06-01T00:00:00.000Z"),
        result: {
          exitCode: 1,
          stdout: "",
          stderr: "OAuth invalid_grant: login required",
        },
      }),
    ).toMatchObject({
      availability: "reconnect_required",
      reason: "needs_reconnect",
      reconnectRequired: true,
    });
  });

  it("classifies usage limit as limited", () => {
    expect(
      claudeDiagnosticSignalFromProcessResult({
        now: new Date("2026-06-01T00:00:00.000Z"),
        result: {
          exitCode: 1,
          stdout: "usage limit reached, try again in 1h 30m",
          stderr: "",
        },
      }),
    ).toMatchObject({
      availability: "limited",
      reason: "quota_limited",
      rawResetText: "1h 30m",
    });
  });
});

function claudeAccount(input: {
  readonly capacityAccountId?: string;
} = {}): ClaudeDiagnosticAccount {
  return {
    provider: "claude",
    slotId: "account-a",
    ...(input.capacityAccountId
      ? { capacityAccountId: input.capacityAccountId }
      : {}),
  };
}
