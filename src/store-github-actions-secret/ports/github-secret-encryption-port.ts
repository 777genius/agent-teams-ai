import type { GitHubEncryptedSecret } from "../domain/encrypted-secret-policy";
import type { GitHubSecretPlaintextForEncryption } from "../domain/plaintext-session-policy";

export type GitHubRepositoryPublicKey = {
  readonly key: string;
  readonly keyId: string;
};

export type GitHubEncryptedSecretValue = GitHubEncryptedSecret;

export interface GitHubSecretEncryptionPort {
  encryptSecretValue(input: {
    readonly plaintext: GitHubSecretPlaintextForEncryption;
    readonly publicKey: GitHubRepositoryPublicKey;
  }): Promise<GitHubEncryptedSecretValue>;
}
