import type { Linter } from 'eslint';

export function featureOverrides(
  jsxA11y: NonNullable<Linter.Config['plugins']>[string]
): Linter.Config[] {
  return [
    {
      name: 'team-transcript-project-resolver-sonar-override',
      files: ['src/main/services/team/TeamTranscriptProjectResolver.ts'],
      rules: { 'sonarjs/no-identical-functions': 'off' },
    },
    {
      name: 'external-prompt-keyboard-accessibility',
      files: ['src/features/external-agent-connection/renderer/ExternalAgentPromptDialog.tsx'],
      plugins: { 'jsx-a11y': jsxA11y },
      rules: { 'jsx-a11y/no-noninteractive-element-interactions': 'error' },
    },
  ];
}
