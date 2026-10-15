import { lazy, Suspense, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Layers } from 'lucide-react';

const MyTemplatesDialog = lazy(() =>
  import('./MyTemplatesDialog').then((module) => ({ default: module.MyTemplatesDialog }))
);

/**
 * Team-list header action that opens the template library.
 *
 * The dialog is lazy-loaded so its code stays out of the initial bundle, and
 * the custom-template library itself is re-read every time it opens.
 */
export const MyTemplatesAction = (): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <Layers size={13} />
        {t('customTemplates.actions.templates')}
      </Button>
      {open ? (
        <Suspense
          fallback={
            <div
              role="status"
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 text-sm text-[var(--color-text-muted)]"
            >
              {t('customTemplates.states.loading')}
            </div>
          }
        >
          <MyTemplatesDialog open={open} onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
};
