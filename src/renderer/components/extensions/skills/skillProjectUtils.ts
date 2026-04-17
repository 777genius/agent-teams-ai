import type { SkillScope } from '@shared/types/extensions';

export function resolveSkillProjectPath(
  scope: SkillScope,
  currentProjectPath: string | null,
  itemProjectRoot?: string | null
): string | undefined {
  if (scope !== 'project') {
    return undefined;
  }

  return itemProjectRoot ?? currentProjectPath ?? undefined;
}
