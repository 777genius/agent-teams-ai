import type {
  SessionArtifact,
  SessionEnvelope,
  SessionStorePort,
  SessionWriteResult,
} from "@vioxen/subscription-runtime/core";
import {
  githubActionsSecretStoreCapabilities,
  type GitHubActionsSecretSessionSettings,
} from "../domain/github-actions-secret-store-policy";
import {
  readGitHubActionsSecretSession,
  writeGitHubActionsSecretSession,
} from "../application/github-actions-secret-use-cases";
import {
  type EncryptedWritebackClient,
  type GitHubActionsSecretSourcePort,
  type GitHubPublicKeyProvider,
} from "../ports/github-actions-secret-writeback-port";
import type { GitHubSecretEncryptionPort } from "../ports/github-secret-encryption-port";
import { EnvironmentGitHubActionsSecretSource } from "./environment-secret-source";
import { defaultGitHubSecretEncryption } from "./github-secret-encryption";

export type GitHubActionsSecretStoreOptions =
  GitHubActionsSecretSessionSettings & {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly publicKeyProvider: GitHubPublicKeyProvider;
    readonly writebackClient: EncryptedWritebackClient;
    readonly secretEncryption?: GitHubSecretEncryptionPort;
    readonly secretSource?: GitHubActionsSecretSourcePort;
  };

export class GitHubActionsSecretStore implements SessionStorePort {
  readonly storeId = githubActionsSecretStoreCapabilities.storeId;
  readonly custody = githubActionsSecretStoreCapabilities.custody;
  readonly capabilities = githubActionsSecretStoreCapabilities;
  private readonly secretSource: GitHubActionsSecretSourcePort;
  private readonly secretEncryption: GitHubSecretEncryptionPort;

  constructor(private readonly options: GitHubActionsSecretStoreOptions) {
    this.secretSource =
      options.secretSource ??
      new EnvironmentGitHubActionsSecretSource(options.env);
    this.secretEncryption =
      options.secretEncryption ?? defaultGitHubSecretEncryption;
  }

  async read(input: {
    readonly providerInstanceId: string;
    readonly expectedProviderId?: string;
    readonly purpose?: string;
  }): Promise<SessionEnvelope | null> {
    return readGitHubActionsSecretSession({
      settings: this.options,
      secretValue: this.readCurrentSecretValue(),
      read: input,
    });
  }

  async write(input: {
    readonly providerInstanceId: string;
    readonly expectedGeneration: number;
    readonly nextArtifact: SessionArtifact;
    readonly idempotencyKey: string;
    readonly leaseId: string;
  }): Promise<SessionWriteResult> {
    return writeGitHubActionsSecretSession(
      {
        publicKeyProvider: this.options.publicKeyProvider,
        secretEncryption: this.secretEncryption,
        secretSource: this.secretSource,
        writebackClient: this.options.writebackClient,
      },
      {
        settings: this.options,
        write: input,
      },
    );
  }

  private readCurrentSecretValue(): string | undefined {
    return this.secretSource.getSecretValue({
      secretName: this.options.secretName,
    });
  }
}
