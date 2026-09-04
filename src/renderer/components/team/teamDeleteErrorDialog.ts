import { confirm } from '@renderer/components/common/ConfirmDialog';

import type { TranslationNamespace } from '@features/localization';
import type { TFunction } from 'i18next';

type TeamTranslator = TFunction<TranslationNamespace, undefined>;

/**
 * Report a failed team delete to the person who asked for it.
 *
 * Deleting a team is a deliberate, destructive action started from a
 * confirmation dialog, so a failure has to be visible at the same place the
 * action was: the three call sites (move to trash and delete forever in the
 * team list, delete from the team detail view) used to swallow the rejection
 * on the assumption that the store banner would carry it, which it does not
 * for these paths. The main process now produces concrete messages - a quiesce
 * that timed out, a rename Windows would not allow - and this shows them
 * verbatim, falling back to a generic line only when the rejection is not an
 * Error.
 */
export function showTeamDeleteError(t: TeamTranslator, error: unknown): void {
  void confirm({
    title: t('list.deleteFailed.title'),
    message: error instanceof Error ? error.message : t('list.deleteFailed.fallbackMessage'),
    confirmLabel: t('list.deleteFailed.confirmLabel'),
    variant: 'danger',
  });
}
