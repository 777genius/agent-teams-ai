const CODEX_SHELL_ENVIRONMENT_INCLUDE_ONLY = [
  "PATH",
  "HOME",
  "CI",
  "CODEX_HOME",
] as const;

export function codexShellEnvironmentPolicyConfigToml(): string {
  return [
    "[shell_environment_policy]",
    'inherit = "all"',
    `include_only = ["${CODEX_SHELL_ENVIRONMENT_INCLUDE_ONLY.join('", "')}"]`,
  ].join("\n");
}
