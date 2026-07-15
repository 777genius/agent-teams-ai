import { describe, expect, it } from "vitest";

import {
  detectSecretLikeContent,
  matchesSecretLikeContentPatterns,
  OpaqueSecretDetectionPolicy,
  type SecretLikeContentKind,
} from "../secret-detection";

function joined(...parts: readonly string[]): string {
  return parts.join("");
}

function assignment(keyParts: readonly string[], valueParts: readonly string[]): string {
  return joined(keyParts.join(""), "=", valueParts.join(""));
}

function quotedAssignment(
  keyParts: readonly string[],
  valueParts: readonly string[],
): string {
  return joined(keyParts.join(""), ": '", valueParts.join(""), "'");
}

function base64UrlJson(value: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

const exactFixtureLiterals = [
  ["test-", "fixture-literal"],
  ["fixture-", "fixture-literal"],
  ["example-", "fixture-literal"],
  ["placeholder-", "fixture-literal"],
] as const;

describe("secure fixture secret detection", () => {
  it.each(exactFixtureLiterals)(
    "allows exact fixture literal %s only with an explicit fixture context",
    (...valueParts) => {
      const content = assignment(["API_", "KEY"], valueParts);

      expect(detectSecretLikeContent(content, {
        filePath: "src/worker-core/tests/credential-fixtures.test.ts",
      })).toBeUndefined();
      expect(detectSecretLikeContent(Buffer.from(content), {
        filePath: "test/fixtures/config.env",
      })).toBeUndefined();
      expect(detectSecretLikeContent(content)).toBe("env_secret_assignment");
      expect(detectSecretLikeContent(content, {
        filePath: "src/contest/config.ts",
      })).toBe("env_secret_assignment");
      expect(detectSecretLikeContent(content, {
        filePath: "src/fixtures-adjacent/config.ts",
      })).toBe("env_secret_assignment");
    },
  );

  it.each([
    ["exact fixture literal", ["test-", "fixture-literal"]],
    ["arbitrary suffix", ["test-", "production-bridge-key-material"]],
  ] as const)("keeps the configurable bridge key authoritative for %s", (
    _label,
    valueParts,
  ) => {
    const configurableBridgeKey = [
      "SUBSCRIPTION_RUNTIME_",
      "OPENAI_BRIDGE_",
      "API_KEY",
    ];
    const content = assignment(configurableBridgeKey, valueParts);

    expect(detectSecretLikeContent(content, {
      filePath: "src/openai-compatible-codex/tests/config.test.ts",
    })).toBe("env_secret_assignment");
  });

  it("handles quoted, unquoted, diff-prefixed, cased, and CRLF fixture forms", () => {
    const value = ["fixture-", "fixture-literal"];
    const content = [
      joined("+  ", quotedAssignment(["Api_", "Key"], value)),
      joined("-  ", ["client_", "secret"].join(""), " : ", value.join("")),
    ].join("\r\n");

    expect(detectSecretLikeContent(content, {
      filePath: "__fixtures__/credential-values.spec.ts",
    })).toBeUndefined();
    expect(detectSecretLikeContent(Buffer.from(content), {
      filePath: "__fixtures__/credential-values.spec.ts",
    })).toBeUndefined();
  });

  it.each([
    ["different suffix", ["test-", "fixture-literal-extra"]],
    ["uppercase prefix", ["Test-", "fixture-literal"]],
    ["underscore boundary", ["fixture_", "fixture-literal"]],
  ] as const)("rejects the %s near miss", (_label, valueParts) => {
    expect(detectSecretLikeContent(
      assignment(["API_", "KEY"], valueParts),
      { filePath: "tests/near-miss.fixture.ts" },
    )).toBe("env_secret_assignment");
  });

  it.each([
    [
      "OpenAI",
      ["test-", ["s", "k", "-"].join(""), "a".repeat(24)],
      "openai_token",
    ],
    [
      "GitHub",
      ["fixture-", ["g", "h", "p", "_"].join(""), "b".repeat(24)],
      "github_token",
    ],
    [
      "Slack",
      ["example-", ["x", "o", "x", "b", "-"].join(""), "c".repeat(24)],
      "slack_token",
    ],
    [
      "AWS",
      ["placeholder-", ["A", "K", "I", "A"].join(""), "D".repeat(16)],
      "aws_access_key",
    ],
    [
      "private key",
      [
        "test-",
        ["---", "--BEGIN ", "PRIVATE", " KEY", "---", "--"].join(""),
      ],
      "private_key",
    ],
  ] as const)(
    "keeps %s signatures authoritative in fixture contexts",
    (_label, valueParts, expected: SecretLikeContentKind) => {
      const content = quotedAssignment(["api_", "key"], valueParts);
      expect(detectSecretLikeContent(content, {
        filePath: "tests/provider-fixture.test.ts",
      })).toBe(expected);
    },
  );

  it("detects Bearer and JWT material before fixture exemptions", () => {
    const jwt = [
      base64UrlJson({ alg: "HS256", typ: "JWT" }),
      base64UrlJson({ sub: "fixture-user", exp: 4_102_444_800 }),
      "signaturepart",
    ].join(".");
    const idToken = assignment(["id_", "token"], ["test-", jwt]);
    const bearer = joined(["Author", "ization"].join(""), ": ", ["Bear", "er"].join(""), " ", jwt);

    expect(detectSecretLikeContent(idToken, {
      filePath: "tests/auth.fixture.ts",
    })).toBe("jwt_token");
    expect(detectSecretLikeContent(bearer, {
      filePath: "tests/auth.fixture.ts",
    })).toBe("bearer_token");
  });

  it.each([
    "subscription.runtime.workerOutput",
    "configuredProvider.accountRegistry.current",
    "projectIntegration.localAdapters.scanner",
    "someReallyLongIdentifier.anotherLongProperty.finalProperty",
  ])("does not treat an ordinary TypeScript property chain as JWT material: %s", (chain) => {
    expect(detectSecretLikeContent(`const selected = ${chain};`)).toBeUndefined();
  });

  it("detects compact JWTs with JSON claims and signed or unsecured forms", () => {
    const header = base64UrlJson({ typ: "JWT", alg: "none" });
    const payload = base64UrlJson({ iss: "fixture", sub: "subject" });

    expect(detectSecretLikeContent(`${header}.${payload}.`)).toBe("jwt_token");
    expect(detectSecretLikeContent(
      `${base64UrlJson({ alg: "RS256" })}.${payload}.signedbytes`,
    )).toBe("jwt_token");
  });

  it("scans every generic match instead of accepting mixed content", () => {
    const safe = assignment(["API_", "KEY"], ["test-", "fixture-literal"]);
    const unsafe = assignment(
      ["CLIENT_", "SECRET"],
      ["production-", "credential-material"],
    );
    const content = joined(safe, "\r\n+", unsafe, "\r\n");

    expect(detectSecretLikeContent(content, {
      filePath: "tests/mixed.fixture.env",
    })).toBe("env_secret_assignment");
  });

  it("keeps configured patterns authoritative and resets their state", () => {
    const content = joined("test-", "fixture-literal");
    const configured = new RegExp(joined("test-", "fixture"), "g");

    expect(matchesSecretLikeContentPatterns(content, [configured])).toBe(true);
    expect(configured.lastIndex).toBe(0);
    expect(matchesSecretLikeContentPatterns(content, [configured])).toBe(true);
    expect(configured.lastIndex).toBe(0);
  });

  it("fails closed on opaque buffers after checking signatures", () => {
    const opaque = Buffer.from([0x00, 0xff, 0x01, 0x02]);
    const providerInBinary = Buffer.concat([
      Buffer.from([0x00]),
      Buffer.from(joined(["s", "k", "-"].join(""), "z".repeat(24))),
      Buffer.from([0xff]),
    ]);

    expect(detectSecretLikeContent(opaque)).toBe("opaque_content");
    expect(detectSecretLikeContent(providerInBinary)).toBe("openai_token");
    expect(detectSecretLikeContent(opaque, {
      filePath: "reviewed-output.bin",
      opaqueContentPolicy: OpaqueSecretDetectionPolicy.ScanKnownSignatures,
    })).toBeUndefined();
    expect(detectSecretLikeContent(providerInBinary, {
      filePath: "reviewed-output.bin",
      opaqueContentPolicy: OpaqueSecretDetectionPolicy.ScanKnownSignatures,
    })).toBe("openai_token");
  });
});
