import sodium from "libsodium-wrappers";
import { assertLooksLikeGitHubSealedBox } from "./no-plaintext-boundary";

export type GitHubRepositoryPublicKey = {
  readonly key: string;
  readonly keyId: string;
};

export type GitHubEncryptedSecretValue = {
  readonly encryptedValue: string;
  readonly keyId: string;
};

export async function encryptGitHubSecretValue(input: {
  readonly plaintext: string;
  readonly publicKey: GitHubRepositoryPublicKey;
}): Promise<GitHubEncryptedSecretValue> {
  await sodium.ready;
  const keyBytes = sodium.from_base64(
    input.publicKey.key,
    sodium.base64_variants.ORIGINAL,
  );
  const encryptedBytes = sodium.crypto_box_seal(
    sodium.from_string(input.plaintext),
    keyBytes,
  );
  const encryptedValue = sodium.to_base64(
    encryptedBytes,
    sodium.base64_variants.ORIGINAL,
  );
  assertLooksLikeGitHubSealedBox(encryptedValue);
  return {
    encryptedValue,
    keyId: input.publicKey.keyId,
  };
}
