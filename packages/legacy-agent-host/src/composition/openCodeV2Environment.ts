/**
 * Official OpenCode V2 accepts OPENCODE_BIN_PATH as an executable override.
 * Windows environment variable names are case-insensitive. Refuse aliases
 * on every platform so Linux qualification cannot approve a Windows bypass.
 * Inspect the entire captured/inherited key set, not one property lookup.
 */
export function hasUntrustedOpenCodeBinaryOverride(
  environment: Readonly<Record<string, unknown>>
): boolean {
  return Object.keys(environment).some((key) => key.toUpperCase() === 'OPENCODE_BIN_PATH');
}
