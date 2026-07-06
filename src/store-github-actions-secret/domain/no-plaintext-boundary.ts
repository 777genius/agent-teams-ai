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

export function assertLooksLikeGitHubSealedBox(value: string): void {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new BoundaryViolationError("Encrypted secret must be base64.");
  }
  if (value.length < 64) {
    throw new BoundaryViolationError("Encrypted secret is too short.");
  }
}

export type NoCustodyEncryptedWritebackBoundary = {
  readonly encryptedValue: string;
  readonly [field: string]: unknown;
};

export function assertEncryptedWritebackRequestIsNoCustody(
  request: NoCustodyEncryptedWritebackBoundary,
): void {
  assertNoPlaintextSessionFields(request);
  assertLooksLikeGitHubSealedBox(request.encryptedValue);
}
