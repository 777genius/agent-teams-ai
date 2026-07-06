export function claudeCliChildEnv(input: {
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly configDir: string;
  readonly oauthToken: string;
}): Readonly<Record<string, string>> {
  return definedEnv({
    ...pruneClaudeChildEnv(input.baseEnv),
    HOME: input.configDir,
    CLAUDE_CONFIG_DIR: input.configDir,
    CLAUDE_CODE_OAUTH_TOKEN: input.oauthToken,
    CI: "true",
  });
}

function pruneClaudeChildEnv(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const allowed = new Set([
    "CI",
    "LANG",
    "LC_ALL",
    "PATH",
    "TEMP",
    "TMP",
    "TMPDIR",
  ]);
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) =>
      value !== undefined &&
      (allowed.has(key) || key.startsWith("LC_"))
    ),
  );
}

function definedEnv(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined
    ),
  );
}
