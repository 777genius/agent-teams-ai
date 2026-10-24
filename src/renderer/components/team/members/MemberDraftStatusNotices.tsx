import React from 'react';

import { AnthropicExtraUsageWarning } from '@renderer/components/team/dialogs/AnthropicExtraUsageWarning';
import { AlertTriangle, Info } from 'lucide-react';

interface MemberDraftStatusNoticesProps {
  warningMessages: readonly string[];
  showSonnetExtraUsageWarning: boolean;
  errorText?: string | null;
  infoText?: string | null;
}

export const MemberDraftStatusNotices = ({
  warningMessages,
  showSonnetExtraUsageWarning,
  errorText,
  infoText,
}: MemberDraftStatusNoticesProps): React.JSX.Element => (
  <>
    {warningMessages.length > 0 || showSonnetExtraUsageWarning ? (
      <div className="md:col-span-3">
        <div className="bg-amber-500/8 ml-3 flex items-start gap-2 rounded-md border border-amber-500/25 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-200">
          <Info className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
          <div className="space-y-1">
            {warningMessages.map((message) => (
              <p key={message}>{message}</p>
            ))}
            {showSonnetExtraUsageWarning ? <AnthropicExtraUsageWarning /> : null}
          </div>
        </div>
      </div>
    ) : null}
    {errorText ? (
      <div className="md:col-span-3">
        <div
          className="ml-3 flex items-start gap-2 rounded-md border border-[var(--field-error-border)] bg-[var(--field-error-bg)] px-3 py-2 text-[11px] leading-relaxed text-[var(--field-error-text)]"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <p className="min-w-0 whitespace-pre-wrap break-words">{errorText}</p>
        </div>
      </div>
    ) : null}
    {infoText ? (
      <div className="md:col-span-3">
        <div className="ml-3 flex items-start gap-2 rounded-md border border-sky-600/25 bg-sky-500/10 px-3 py-2 text-[11px] leading-relaxed text-sky-800 dark:border-sky-400/25 dark:text-sky-100">
          <Info className="mt-0.5 size-3.5 shrink-0 text-sky-700 dark:text-sky-300" />
          <p className="min-w-0 whitespace-pre-wrap break-words">{infoText}</p>
        </div>
      </div>
    ) : null}
  </>
);
