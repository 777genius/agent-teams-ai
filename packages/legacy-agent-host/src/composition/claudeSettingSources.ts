import type { ClaudeMemberProfile } from './runtimeProfile.js';

type SettingSources = NonNullable<
  NonNullable<ClaudeMemberProfile['nativeOptions']>['settingSources']
>;

/** MCP policy never disables unrelated native instructions, skills or hooks. */
export function captureClaudeSettingSources(
  selected: readonly SettingSources[number][] | undefined
): SettingSources {
  return [...(selected ?? ['user', 'project', 'local'])];
}
