import { describe, expect, it } from 'vitest';

import { buildSlashCommandSuggestions } from '@renderer/utils/skillCommandSuggestions';
import { KNOWN_SLASH_COMMANDS } from '@shared/utils/slashCommands';

import type { SkillCatalogItem } from '@shared/types/extensions';

function createSkill(overrides: Partial<SkillCatalogItem>): SkillCatalogItem {
  return {
    id: overrides.id ?? 'skill-id',
    sourceType: 'filesystem',
    name: overrides.name ?? 'Skill Name',
    description: overrides.description ?? 'Skill description',
    folderName: overrides.folderName ?? 'skill-name',
    scope: overrides.scope ?? 'project',
    rootKind: overrides.rootKind ?? 'claude',
    projectRoot: overrides.projectRoot ?? '/Users/test/project',
    discoveryRoot: overrides.discoveryRoot ?? '/Users/test/project/.claude/skills',
    skillDir: overrides.skillDir ?? '/Users/test/project/.claude/skills/skill-name',
    skillFile: overrides.skillFile ?? '/Users/test/project/.claude/skills/skill-name/SKILL.md',
    metadata: overrides.metadata ?? {},
    invocationMode: overrides.invocationMode ?? 'manual-only',
    flags: overrides.flags ?? { hasScripts: false, hasReferences: false, hasAssets: false },
    isValid: overrides.isValid ?? true,
    issues: overrides.issues ?? [],
    modifiedAt: overrides.modifiedAt ?? 0,
  };
}

describe('buildSlashCommandSuggestions', () => {
  it('keeps built-ins and adds valid skills in a separate suggestion type', () => {
    const suggestions = buildSlashCommandSuggestions(
      KNOWN_SLASH_COMMANDS,
      [createSkill({ id: 'project-skill', folderName: 'review-skill', scope: 'project' })],
      []
    );

    expect(suggestions[0]?.type).toBe('command');
    expect(suggestions.some((suggestion) => suggestion.type === 'skill')).toBe(true);
    expect(suggestions.find((suggestion) => suggestion.id === 'skill:project-skill')).toMatchObject(
      {
        name: 'review-skill',
        command: '/review-skill',
        subtitle: 'Project skill - Shared',
        type: 'skill',
      }
    );
  });

  it('filters slash-unsafe names and built-in collisions', () => {
    const suggestions = buildSlashCommandSuggestions(
      KNOWN_SLASH_COMMANDS,
      [
        createSkill({ id: 'unsafe', folderName: 'bad skill' }),
        createSkill({ id: 'collision', folderName: 'plan' }),
      ],
      []
    );

    expect(suggestions.find((suggestion) => suggestion.id === 'skill:unsafe')).toBeUndefined();
    expect(suggestions.find((suggestion) => suggestion.id === 'skill:collision')).toBeUndefined();
  });

  it('prefers project skills when user and project skills share the same slash name', () => {
    const suggestions = buildSlashCommandSuggestions(
      KNOWN_SLASH_COMMANDS,
      [createSkill({ id: 'project', folderName: 'shared-skill', scope: 'project' })],
      [createSkill({ id: 'user', folderName: 'shared-skill', scope: 'user' })]
    );

    expect(suggestions.filter((suggestion) => suggestion.command === '/shared-skill')).toHaveLength(
      1
    );
    expect(suggestions.find((suggestion) => suggestion.command === '/shared-skill')?.id).toBe(
      'skill:project'
    );
  });

  it('hides codex-only skills when the provider is not codex', () => {
    const suggestions = buildSlashCommandSuggestions(
      KNOWN_SLASH_COMMANDS,
      [createSkill({ id: 'codex-project', folderName: 'codex-skill', rootKind: 'codex' })],
      [],
      'anthropic'
    );

    expect(suggestions.find((suggestion) => suggestion.id === 'skill:codex-project')).toBeUndefined();
  });

  it('prefers codex-only overlays ahead of shared skills for codex teams', () => {
    const suggestions = buildSlashCommandSuggestions(
      KNOWN_SLASH_COMMANDS,
      [
        createSkill({
          id: 'shared-project',
          folderName: 'review-skill',
          rootKind: 'claude',
          scope: 'project',
        }),
        createSkill({
          id: 'codex-project',
          folderName: 'review-skill',
          rootKind: 'codex',
          scope: 'project',
        }),
      ],
      [],
      'codex'
    );

    expect(suggestions.filter((suggestion) => suggestion.command === '/review-skill')).toHaveLength(
      1
    );
    expect(suggestions.find((suggestion) => suggestion.command === '/review-skill')?.id).toBe(
      'skill:codex-project'
    );
  });

  it('uses the provided built-in set when filtering skill collisions', () => {
    const suggestions = buildSlashCommandSuggestions(
      [
        {
          name: 'custom-cmd',
          command: '/custom-cmd',
          description: 'Custom command',
        },
      ],
      [createSkill({ id: 'collision', folderName: 'custom-cmd' })],
      []
    );

    expect(suggestions.find((suggestion) => suggestion.id === 'skill:collision')).toBeUndefined();
  });
});
