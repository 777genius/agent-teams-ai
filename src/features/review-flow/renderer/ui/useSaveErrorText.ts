import { useAppTranslation } from '@features/localization/renderer';

import { REVIEW_FLOW_PROJECT_BOARDS_NOT_UPDATED } from '../../contracts/errors';

/**
 * The text of a failed save in the app language. A save that reached the team but not every project
 * board arrives as its code: the projects are then listed by the editor from the overview.
 */
export function useSaveErrorText(): (message: string) => string {
  const { t } = useAppTranslation('team');
  return (message) =>
    message === REVIEW_FLOW_PROJECT_BOARDS_NOT_UPDATED
      ? t('reviewFlow.feedback.notApplied')
      : t('reviewFlow.feedback.error', { message });
}
