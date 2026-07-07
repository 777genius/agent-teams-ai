import { BoundaryViolationError } from "@vioxen/subscription-runtime/core";

export type GitHubSealedBoxCiphertext = string;

export type GitHubEncryptedSecret = {
  readonly encryptedValue: GitHubSealedBoxCiphertext;
  readonly keyId: string;
};

export function assertLooksLikeGitHubSealedBox(value: string): void {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new BoundaryViolationError("Encrypted secret must be base64.");
  }
  if (value.length < 64) {
    throw new BoundaryViolationError("Encrypted secret is too short.");
  }
}

export function sealGitHubEncryptedSecret(input: {
  readonly encryptedValue: string;
  readonly keyId: string;
}): GitHubEncryptedSecret {
  assertLooksLikeGitHubSealedBox(input.encryptedValue);
  return {
    encryptedValue: input.encryptedValue,
    keyId: input.keyId,
  };
}
