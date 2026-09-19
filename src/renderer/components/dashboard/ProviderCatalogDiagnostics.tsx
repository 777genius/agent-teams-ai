import { useId, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown } from 'lucide-react';

export const ProviderCatalogDiagnostics = ({ message }: { readonly message: string }) => {
  const { t } = useAppTranslation('common');
  const [open, setOpen] = useState(false);
  const diagnosticsLabelId = useId();
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="w-full min-w-0 max-w-full">
      <Collapsible.Trigger className="inline-flex max-w-full items-center gap-1 rounded text-left text-[11px] text-amber-400 focus-visible:outline focus-visible:outline-2">
        <span id={diagnosticsLabelId}>{t('providerModelBadges.checkFailed')}</span>
        <span>{t(open ? 'actions.showLess' : 'actions.showMore')}</span>
        <ChevronDown
          className={open ? 'size-3 shrink-0 rotate-180' : 'size-3 shrink-0'}
          aria-hidden="true"
        />
      </Collapsible.Trigger>
      <Collapsible.Content className="min-w-0 max-w-full">
        {/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- This named scroll region needs keyboard focus so long diagnostics can be scrolled without a mouse. */}
        <pre
          tabIndex={0}
          role="region"
          aria-labelledby={diagnosticsLabelId}
          className="mt-1 max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--color-border)] p-2 text-[11px] text-[var(--color-text-secondary)] [overflow-wrap:anywhere]"
        >
          {message}
        </pre>
        {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
      </Collapsible.Content>
    </Collapsible.Root>
  );
};
