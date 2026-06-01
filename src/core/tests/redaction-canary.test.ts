import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "../index";

describe("subscription runtime redaction canary", () => {
  it("redacts provider token spellings used by CLI logs and JSON auth files", () => {
    const redactor = new DefaultRedactor();
    redactor.registerSecret("registered-secret", "registered");

    const redacted = redactor.redact(
      [
        "refresh_token=refresh-raw",
        "access_token: access-raw",
        '"id_token":"id-raw"',
        "Bearer bearer-raw",
        "registered-secret",
      ].join("\n"),
    );

    expect(redacted).not.toContain("refresh-raw");
    expect(redacted).not.toContain("access-raw");
    expect(redacted).not.toContain("id-raw");
    expect(redacted).not.toContain("bearer-raw");
    expect(redacted).not.toContain("registered-secret");
    expect(redacted).toContain("refresh_token=[redacted:token-field]");
    expect(redacted).toContain("access_token=[redacted:token-field]");
    expect(redacted).toContain("id_token=[redacted:token-field]");
    expect(redacted).toContain("Bearer [redacted]");
    expect(redacted).toContain("[redacted:registered]");
  });
});
