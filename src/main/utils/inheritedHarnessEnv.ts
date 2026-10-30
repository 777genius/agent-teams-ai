/**
 * Session-scoped variables a parent Claude Code harness exports to its children.
 * Exact names only: never strip by a CLAUDE_* prefix, auth, config dir, runtime
 * path and AGENT_TEAMS_* / CLAUDE_TEAM_* variables must survive.
 */
export const INHERITED_HARNESS_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_VERSION',
  'CLAUDE_CODE_INVOKED_SKILLS',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  'TRACEPARENT',
] as const;

export function stripInheritedHarnessEnv(env: NodeJS.ProcessEnv): void {
  for (const key of INHERITED_HARNESS_ENV_KEYS) {
    delete env[key];
  }
}
