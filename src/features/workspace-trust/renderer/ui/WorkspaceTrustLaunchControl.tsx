import './workspaceTrustLaunchControl.css';

import { Button } from '@renderer/components/ui/button';
import { Loader2, Play } from 'lucide-react';

import { shouldShowWorkspaceTrustLaunchNotice } from '../hooks/useWorkspaceTrustStatus';

import { WorkspaceTrustLaunchNotice } from './WorkspaceTrustLaunchNotice';

import type { WorkspaceTrustDisplayStatus } from '../hooks/useWorkspaceTrustStatus';

export const WorkspaceTrustLaunchControl = (props: {
  status: WorkspaceTrustDisplayStatus;
  isLaunchMode: boolean;
  disabled: boolean;
  describedBy?: string;
  busy: boolean;
  submittingLabel: string;
  submitLabel: string;
  onClick: () => void;
}): React.JSX.Element => {
  const emphasize =
    props.isLaunchMode &&
    shouldShowWorkspaceTrustLaunchNotice(props.status) &&
    !props.disabled &&
    !props.busy;

  return (
    <div className="flex shrink-0 flex-col items-end gap-2">
      <WorkspaceTrustLaunchNotice status={props.status} />
      <Button
        size={props.isLaunchMode ? 'lg' : 'sm'}
        className={
          props.isLaunchMode
            ? `relative h-11 min-w-40 overflow-hidden bg-emerald-600 px-5 text-base font-semibold text-white shadow-md shadow-emerald-950/30 hover:bg-emerald-700 ${
                emphasize ? 'workspace-trust-launch-cta' : ''
              }`
            : 'bg-emerald-600 text-white hover:bg-emerald-700'
        }
        disabled={props.disabled}
        aria-describedby={props.describedBy}
        onClick={props.onClick}
      >
        {props.busy ? (
          <>
            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            {props.submittingLabel}
          </>
        ) : (
          <>
            {props.isLaunchMode ? (
              <Play className="size-[18px] fill-current" aria-hidden="true" />
            ) : null}
            {props.submitLabel}
          </>
        )}
      </Button>
    </div>
  );
};
