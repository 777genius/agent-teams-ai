import { isSupportedSlashCommandName } from '@shared/utils/slashCommands';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { SkillCatalogItem } from '@shared/types/extensions';
import type { KnownSlashCommandDefinition } from '@shared/utils/slashCommands';

export function buildSlashCommandSuggestions(
  builtIns: readonly KnownSlashCommandDefinition[],
  projectSkills: readonly SkillCatalogItem[],
  userSkills: readonly SkillCatalogItem[]
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
  for (const skill of [...projectSkills, ...userSkills]) {
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
      subtitle: skill.scope === 'project' ? 'Project skill' : 'Personal skill',
      searchText: `${skill.name} ${skill.folderName}`,
      type: 'skill',
    });
  }

  return [...builtInSuggestions, ...skillSuggestions];
}
