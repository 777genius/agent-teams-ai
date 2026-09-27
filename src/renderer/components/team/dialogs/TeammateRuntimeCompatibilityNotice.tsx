import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { AlertTriangle, Info } from 'lucide-react';

import type { TeammateRuntimeCompatibility } from './teammateRuntimeCompatibility';

interface TeammateRuntimeCompatibilityNoticeProps {
  readonly analysis: TeammateRuntimeCompatibility;
  readonly onOpenDashboard?: () => void;
  readonly showMemberErrors?: boolean;
}

export const TeammateRuntimeCompatibilityNotice = ({
  analysis,
  onOpenDashboard,
  showMemberErrors = false,
}: TeammateRuntimeCompatibilityNoticeProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');

  if (!analysis.visible) {
    return null;
  }
  const Icon = analysis.checking ? Info : AlertTriangle;
  const isError = analysis.blocksSubmission && !analysis.checking;
  const memberErrors = showMemberErrors ? Object.values(analysis.memberErrorById) : [];
  return (
    <div
      className="rounded-md border p-3 text-xs"
      data-testid={showMemberErrors ? 'teammate-runtime-preflight-error' : undefined}
      role={isError ? 'alert' : 'status'}
      style={{
        backgroundColor: isError ? 'var(--field-error-bg)' : 'var(--warning-bg)',
        borderColor: isError ? 'var(--field-error-border)' : 'var(--warning-border)',
        color: isError ? 'var(--field-error-text)' : 'var(--warning-text)',
      }}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium">{analysis.title}</p>
          {memberErrors.length > 0 ? (
            memberErrors.map((error) => <p key={error}>{error}</p>)
          ) : (
            <p className="opacity-80">{analysis.message}</p>
          )}
          {analysis.tmuxDetail ? (
            <p className="text-[11px] opacity-70">{analysis.tmuxDetail}</p>
          ) : null}
          {!showMemberErrors && analysis.details.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-4 text-[11px] opacity-80">
              {analysis.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
          {onOpenDashboard ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-1 h-7 px-2 text-[11px]"
              onClick={onOpenDashboard}
            >
              {t('dialogs.actions.openDashboard')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
};
