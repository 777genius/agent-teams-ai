import React from 'react';

import { Button } from '@renderer/components/ui/button';
import { AlertTriangle, Info } from 'lucide-react';

import type { TeammateRuntimeCompatibility } from './teammateRuntimeCompatibility';

interface TeammateRuntimeCompatibilityNoticeProps {
  readonly analysis: TeammateRuntimeCompatibility;
  readonly onOpenDashboard?: () => void;
}

export const TeammateRuntimeCompatibilityNotice = ({
  analysis,
  onOpenDashboard,
}: TeammateRuntimeCompatibilityNoticeProps): React.JSX.Element | null => {
  if (!analysis.visible) {
    return null;
  }
  const Icon = analysis.checking ? Info : AlertTriangle;
  return (
    <div
      className="rounded-md border p-3 text-xs"
      style={{
        backgroundColor: 'var(--warning-bg)',
        borderColor: 'var(--warning-border)',
        color: 'var(--warning-text)',
      }}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium">{analysis.title}</p>
          <p className="opacity-80">{analysis.message}</p>
          {analysis.tmuxDetail ? (
            <p className="text-[11px] opacity-70">{analysis.tmuxDetail}</p>
          ) : null}
          {analysis.details.length > 0 ? (
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
              Open Dashboard
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
};
