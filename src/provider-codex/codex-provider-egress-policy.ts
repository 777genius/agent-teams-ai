export const codexProviderEgressProfileEnvVar =
  "SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE";

export const codexProviderApiEgressProfileId = "codex-provider-api" as const;

export type CodexProviderEgressProfileId =
  typeof codexProviderApiEgressProfileId;

export type CodexProviderEgressPolicy = {
  readonly profileId: CodexProviderEgressProfileId;
  readonly domains: readonly string[];
};

const codexProviderApiDomains = ["api.openai.com"] as const;

export function codexProviderApiEgressPolicy(): CodexProviderEgressPolicy {
  return {
    profileId: codexProviderApiEgressProfileId,
    domains: codexProviderApiDomains,
  };
}

export function codexProviderEgressPolicyFromEnv(
  sourceEnv: Readonly<Record<string, string | undefined>> | undefined,
): CodexProviderEgressPolicy | null {
  const profileId = sourceEnv?.[codexProviderEgressProfileEnvVar]?.trim();
  if (!profileId) return null;
  if (profileId === codexProviderApiEgressProfileId) {
    return codexProviderApiEgressPolicy();
  }
  return null;
}

export function codexProviderEgressEnv(
  policy: CodexProviderEgressPolicy = codexProviderApiEgressPolicy(),
): Record<string, string> {
  return { [codexProviderEgressProfileEnvVar]: policy.profileId };
}

export function codexProviderEgressNetworkAccessFromEnv(
  sourceEnv: Readonly<Record<string, string | undefined>> | undefined,
): boolean {
  return codexProviderEgressPolicyFromEnv(sourceEnv) !== null;
}

export function codexProviderEgressConfigToml(
  policy: CodexProviderEgressPolicy = codexProviderApiEgressPolicy(),
): string {
  return [
    "# Provider egress stays constrained to the trusted Codex model API profile.",
    "[sandbox_workspace_write]",
    "network_access = true",
    "",
    "[features.network_proxy]",
    "enabled = true",
    `domains = { ${tomlDomainRules(policy)} }`,
    "",
  ].join("\n");
}

export function codexProviderEgressCliConfigArgs(
  policy: CodexProviderEgressPolicy = codexProviderApiEgressPolicy(),
): readonly string[] {
  return [
    "--config",
    "sandbox_workspace_write.network_access=true",
    "--config",
    "features.network_proxy.enabled=true",
    "--config",
    `features.network_proxy.domains={ ${tomlDomainRules(policy)} }`,
  ];
}

function tomlDomainRules(policy: CodexProviderEgressPolicy): string {
  return policy.domains.map((domain) => `${tomlString(domain)} = "allow"`).join(", ");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
