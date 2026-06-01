export type GitHubRepositoryPublicKey = {
    readonly key: string;
    readonly keyId: string;
};
export type GitHubEncryptedSecretValue = {
    readonly encryptedValue: string;
    readonly keyId: string;
};
export declare function encryptGitHubSecretValue(input: {
    readonly plaintext: string;
    readonly publicKey: GitHubRepositoryPublicKey;
}): Promise<GitHubEncryptedSecretValue>;
//# sourceMappingURL=github-secret-encryption.d.ts.map