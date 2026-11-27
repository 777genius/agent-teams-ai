import type { TranslationNamespace } from '@features/localization';
import type { TeamFastMode, TeamProjectContextMode, TeamProviderId } from '@shared/types';
import type { TFunction } from 'i18next';

type TeamTranslator = TFunction<TranslationNamespace, undefined>;

export interface LaunchOptionalSummaryInput {
  launchTeam: boolean;
  projectContextMode: TeamProjectContextMode;
  prompt: string;
  skipPermissions: boolean;
  selectedProviderId: TeamProviderId;
  selectedFastMode: TeamFastMode | undefined;
  anthropicProviderFastModeDefault: boolean;
  limitAnthropicContext: boolean;
  worktreeEnabled: boolean;
  worktreeName: string;
  customArgs: string;
}

/**
 * Chips shown on the collapsed "Optional launch settings" section of Create Team.
 * Launch settings only count when the team is launched right away; the history
 * mode always shows, last, so a changed launch setting wins the limited slots.
 */
export function buildLaunchOptionalSummary(
  input: Readonly<LaunchOptionalSummaryInput>,
  t: TeamTranslator
): string[] {
  const summary: string[] = [];
  if (input.launchTeam) {
    if (input.prompt.trim()) summary.push(t('create.optional.summary.leadPrompt'));
    if (input.skipPermissions) summary.push(t('create.optional.summary.autoApproveTools'));
    if (input.selectedProviderId === 'anthropic' || input.selectedProviderId === 'codex') {
      if (input.selectedFastMode === 'on') summary.push(t('create.optional.summary.fastMode'));
      else if (input.selectedFastMode === 'off') {
        summary.push(t('create.optional.summary.fastDisabled'));
      } else if (input.selectedProviderId === 'anthropic' && input.anthropicProviderFastModeDefault) {
        summary.push(t('create.optional.summary.fastDefault'));
      }
    }
    if (input.limitAnthropicContext) {
      summary.push(t('create.optional.summary.anthropicLimitedContext'));
    }
    if (input.worktreeEnabled && input.worktreeName.trim()) {
      summary.push(t('create.optional.summary.worktree', { name: input.worktreeName.trim() }));
    }
    if (input.customArgs.trim()) summary.push(t('create.optional.summary.customCliArgs'));
  }
  summary.push(
    t(
      input.projectContextMode === 'shared'
        ? 'create.optional.summary.historyShared'
        : 'create.optional.summary.historyPerProject'
    )
  );
  return summary;
}
