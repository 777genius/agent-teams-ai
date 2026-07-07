import { BoundaryViolationError } from "@vioxen/subscription-runtime/core";

const tokenField = "token";
const accessTokenField = ["access", tokenField].join("_");
const refreshTokenField = ["refresh", tokenField].join("_");
const idTokenField = ["id", tokenField].join("_");

const forbiddenPlaintextKeys = [
  accessTokenField,
  refreshTokenField,
  idTokenField,
  ["auth", "Json"].join(""),
  ["auth", "json"].join("_"),
  "session",
  tokenField,
] as const;

const forbiddenValuePatterns = [
  new RegExp("\\bBearer\\s+[A-Za-z0-9._~+/=-]+", "i"),
  new RegExp("\"auth_mode\"\\s*:\\s*\"chatgpt\"", "i"),
  new RegExp("\"" + refreshTokenField + "\"\\s*:", "i"),
  new RegExp("\"" + accessTokenField + "\"\\s*:", "i"),
  new RegExp("\"" + idTokenField + "\"\\s*:", "i"),
] as const;

export type GitHubSecretPlaintextForEncryption = string;

export function assertNoPlaintextSessionFields(value: unknown): void {
  const json = JSON.stringify(value);

  for (const key of forbiddenPlaintextKeys) {
    if (json.includes(`"${key}"`)) {
      throw new BoundaryViolationError(
        `Plaintext provider field is forbidden at no-custody boundary: ${key}`,
      );
    }
  }

  for (const pattern of forbiddenValuePatterns) {
    if (pattern.test(json)) {
      throw new BoundaryViolationError(
        "Plaintext provider value is forbidden at no-custody boundary.",
      );
    }
  }
}

export function decodeArtifactPlaintextForEncryption(input: {
  readonly bytes: Uint8Array;
}): GitHubSecretPlaintextForEncryption {
  return new TextDecoder().decode(input.bytes);
}
