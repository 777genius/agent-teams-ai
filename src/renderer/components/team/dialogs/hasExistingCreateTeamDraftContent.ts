import type { UseCreateTeamDraftResult } from '@renderer/hooks/useCreateTeamDraft';

interface DraftContent {
  form: Pick<
    UseCreateTeamDraftResult,
    'members' | 'runtimeProviderId' | 'soloTeam' | 'syncModelsWithLead'
  >;
  description: string;
  prompt: string;
  defaultDescription: string;
  hasPromptChips: boolean;
}

/** Matches the existing header's replace-draft protection for every template entry point. */
export function hasExistingCreateTeamDraftContent({
  form,
  description,
  prompt,
  defaultDescription,
  hasPromptChips,
}: DraftContent): boolean {
  const trimmedDescription = description.trim();
  return (
    form.members.length > 0 ||
    (trimmedDescription.length > 0 && trimmedDescription !== defaultDescription.trim()) ||
    prompt.length > 0 ||
    hasPromptChips ||
    Boolean(form.runtimeProviderId) ||
    form.soloTeam ||
    !form.syncModelsWithLead
  );
}
