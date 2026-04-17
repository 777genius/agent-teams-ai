import { getSkillAudienceLabel, isSkillAvailableForProvider } from '@shared/utils/skillRoots';
import { isSupportedSlashCommandName } from '@shared/utils/slashCommands';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { SkillCatalogItem } from '@shared/types/extensions';
import type { TeamProviderId } from '@shared/types';
import type { KnownSlashCommandDefinition } from '@shared/utils/slashCommands';

function orderSkillsForProvider(
  projectSkills: readonly SkillCatalogItem[],
  userSkills: readonly SkillCatalogItem[],
  providerId?: TeamProviderId
): SkillCatalogItem[] {
  const visibleProjectSkills = projectSkills.filter((skill) =>
    isSkillAvailableForProvider(skill.rootKind, providerId)
  );
  const visibleUserSkills = userSkills.filter((skill) =>
    isSkillAvailableForProvider(skill.rootKind, providerId)
  );

  if (providerId !== 'codex') {
    return [...visibleProjectSkills, ...visibleUserSkills];
  }

  const isCodexOnly = (skill: SkillCatalogItem) => skill.rootKind === 'codex';
  return [
    ...visibleProjectSkills.filter(isCodexOnly),
    ...visibleProjectSkills.filter((skill) => !isCodexOnly(skill)),
    ...visibleUserSkills.filter(isCodexOnly),
    ...visibleUserSkills.filter((skill) => !isCodexOnly(skill)),
  ];
}

export function buildSlashCommandSuggestions(
  builtIns: readonly KnownSlashCommandDefinition[],
  projectSkills: readonly SkillCatalogItem[],
  userSkills: readonly SkillCatalogItem[],
  providerId?: TeamProviderId
): MentionSuggestion[] {
  const builtInNames = new Set(builtIns.map((command) => command.name.trim().toLowerCase()));
  const builtInSuggestions: MentionSuggestion[] = builtIns.map((command) => ({
    id: `command:${command.name}`,
    name: command.name,
    command: command.command,
    description: command.description,
    subtitle: command.description,
    type: 'command',
  }));

  const seenSkillNames = new Set<string>();
  const skillSuggestions: MentionSuggestion[] = [];
  for (const skill of orderSkillsForProvider(projectSkills, userSkills, providerId)) {
    const normalizedFolderName = skill.folderName.trim().toLowerCase();
    if (
      !skill.isValid ||
      !normalizedFolderName ||
      !isSupportedSlashCommandName(normalizedFolderName) ||
      builtInNames.has(normalizedFolderName) ||
      seenSkillNames.has(normalizedFolderName)
    ) {
      continue;
    }

    seenSkillNames.add(normalizedFolderName);
    skillSuggestions.push({
      id: `skill:${skill.id}`,
      name: skill.folderName,
      command: `/${normalizedFolderName}`,
      description: skill.description,
      subtitle: `${skill.scope === 'project' ? 'Project skill' : 'Personal skill'} - ${getSkillAudienceLabel(skill.rootKind)}`,
      searchText: `${skill.name} ${skill.folderName}`,
      type: 'skill',
    });
  }

  return [...builtInSuggestions, ...skillSuggestions];
}
