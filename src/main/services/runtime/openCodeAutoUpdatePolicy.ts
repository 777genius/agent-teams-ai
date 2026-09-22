export const OPENCODE_DISABLE_AUTOUPDATE_ENV = 'OPENCODE_DISABLE_AUTOUPDATE';
export const CLAUDE_TEAM_OPENCODE_ALLOW_AUTOUPDATE_ENV = 'CLAUDE_TEAM_OPENCODE_ALLOW_AUTOUPDATE';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isOpenCodeAutoUpdateAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[CLAUDE_TEAM_OPENCODE_ALLOW_AUTOUPDATE_ENV]?.trim().toLowerCase();
  return raw ? ENABLED_VALUES.has(raw) : false;
}

export function applyOpenCodeAutoUpdatePolicy<T extends Record<string, string | undefined>>(
  env: T,
  policyEnv: NodeJS.ProcessEnv = env as NodeJS.ProcessEnv
): T & NodeJS.ProcessEnv {
  const next: Record<string, string | undefined> = { ...env };
  if (isOpenCodeAutoUpdateAllowed(policyEnv)) {
    delete next[OPENCODE_DISABLE_AUTOUPDATE_ENV];
    return next as T & NodeJS.ProcessEnv;
  }
  next[OPENCODE_DISABLE_AUTOUPDATE_ENV] = '1';
  return next as T & NodeJS.ProcessEnv;
}
