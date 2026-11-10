import type { ComposerWorkingSummary } from '@renderer/types/composerDraft';

export function crossTeamDraftMeta(
  summaries: readonly ComposerWorkingSummary[],
  preview: (summary: ComposerWorkingSummary) => string
): Map<string, { groupPreview: string | null; count: number }> {
  const result = new Map<string, { groupPreview: string | null; count: number }>();
  for (const summary of summaries) {
    if (summary.address.target.kind !== 'cross-team') continue;
    const current = result.get(summary.address.target.toTeam) ?? {
      groupPreview: null,
      count: 0,
    };
    result.set(summary.address.target.toTeam, {
      groupPreview:
        summary.address.target.toMember == null ? preview(summary) : current.groupPreview,
      count: current.count + 1,
    });
  }
  return result;
}

export function memberDraftPreviews(
  summaries: readonly ComposerWorkingSummary[],
  selectedTeam: string | null,
  preview: (summary: ComposerWorkingSummary) => string
): Map<string, string> {
  const result = new Map<string, string>();
  if (!selectedTeam) return result;
  for (const summary of summaries) {
    if (
      summary.address.target.kind !== 'cross-team' ||
      summary.address.target.toTeam !== selectedTeam
    ) {
      continue;
    }
    result.set(summary.address.target.toMember ?? '', preview(summary));
  }
  return result;
}
