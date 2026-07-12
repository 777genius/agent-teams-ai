import { describe, expect, it } from "vitest";
import { AgentProvider } from "../../../domain/enums";
import { identityFromAuthJson } from "../CodexAuthReader";

describe("identityFromAuthJson", () => {
  it("reads the provider account id from the nested OpenAI auth claim", () => {
    const idToken = [
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
      Buffer.from(JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "physical-account-a",
        },
      })).toString("base64url"),
      "",
    ].join(".");

    const identity = identityFromAuthJson(
      { tokens: { id_token: idToken } },
      {
        provider: AgentProvider.Codex,
        slotId: "slot-alias",
        authHome: "/tmp/slot-alias",
      },
    );

    expect(identity.providerAccountId).toBe("physical-account-a");
    expect(identity.accountKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.safeIdentity).not.toContain("physical-account-a");
  });
});
