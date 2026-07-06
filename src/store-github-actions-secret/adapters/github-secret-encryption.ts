import sodium from "libsodium-wrappers";
import { assertLooksLikeGitHubSealedBox } from "../domain/no-plaintext-boundary";
import type {
  GitHubEncryptedSecretValue,
  GitHubRepositoryPublicKey,
  GitHubSecretEncryptionPort,
} from "../ports/github-secret-encryption-port";

export class SodiumGitHubSecretEncryption implements GitHubSecretEncryptionPort {
  async encryptSecretValue(input: {
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
}

export const defaultGitHubSecretEncryption = new SodiumGitHubSecretEncryption();

export async function encryptGitHubSecretValue(input: {
  readonly plaintext: string;
  readonly publicKey: GitHubRepositoryPublicKey;
}): Promise<GitHubEncryptedSecretValue> {
  return defaultGitHubSecretEncryption.encryptSecretValue(input);
}
