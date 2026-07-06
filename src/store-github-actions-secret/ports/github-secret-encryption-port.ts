export type GitHubRepositoryPublicKey = {
  readonly key: string;
  readonly keyId: string;
};

export type GitHubEncryptedSecretValue = {
  readonly encryptedValue: string;
  readonly keyId: string;
};

export interface GitHubSecretEncryptionPort {
  encryptSecretValue(input: {
    readonly plaintext: string;
    readonly publicKey: GitHubRepositoryPublicKey;
  }): Promise<GitHubEncryptedSecretValue>;
}
