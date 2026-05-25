/**
 * ContextSwitchOverlay - Full-screen loading overlay during context switches.
 *
 * Displayed when isContextSwitching is true, preventing stale data flash
 * during workspace transitions.
 */

import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { useStore } from '@renderer/store';

export const ContextSwitchOverlay: React.FC = () => {
  const { t } = useAppTranslation('common');
  const isContextSwitching = useStore((state) => state.isContextSwitching);
  const targetContextId = useStore((state) => state.targetContextId);

  if (!isContextSwitching) {
    return null;
  }

  // Format context label for display
  const contextLabel =
    targetContextId === 'local'
      ? t('context.local')
      : (targetContextId?.replace(/^ssh-/, '') ?? t('states.unknown'));

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface">
      <div className="flex flex-col items-center gap-4">
        {/* Spinner */}
        <div className="size-8 animate-spin rounded-full border-4 border-text border-t-transparent" />

        {/* Text */}
        <div className="flex flex-col items-center gap-1">
          <p className="text-text">{t('context.switchingTo', { workspace: contextLabel })}</p>
          <p className="text-sm text-text-secondary">{t('context.loadingWorkspace')}</p>
        </div>
      </div>
    </div>
  );
};
