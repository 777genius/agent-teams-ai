import type { useAppTranslation } from '@features/localization/renderer';

export function buildDefaultTeamDescription(
  teamName: string,
  t: ReturnType<typeof useAppTranslation>['t']
): string {
  const trimmedName = teamName.trim();
  return trimmedName.length > 0
    ? t('create.defaultDescription.named', { teamName: trimmedName })
    : t('create.defaultDescription.fallback');
}
