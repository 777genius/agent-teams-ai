import type { GitHubActionsSecretSourcePort } from "../ports/github-actions-secret-writeback-port";

export class EnvironmentGitHubActionsSecretSource
  implements GitHubActionsSecretSourcePort
{
  constructor(
    private readonly env: Readonly<Record<string, string | undefined>>,
  ) {}

  getSecretValue(input: { readonly secretName: string }): string | undefined {
    return this.env[input.secretName];
  }
}
