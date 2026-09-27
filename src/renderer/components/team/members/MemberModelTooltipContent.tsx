import { cn } from '@renderer/lib/utils';

import * as modelTone from './memberModelToneClasses';

interface MemberModelTooltipContentProps {
  label: string | undefined;
  issue: string | null | undefined;
  advisory: string | null | undefined;
  help: string | null | undefined;
}

export const MemberModelTooltipContent = ({
  label,
  issue,
  advisory,
  help,
}: MemberModelTooltipContentProps): React.JSX.Element => {
  return (
    <>
      <span className="block break-words font-medium">{label}</span>
      {issue ? <span className={cn('block', modelTone.MODEL_ISSUE_TEXT_CLASS)}>{issue}</span> : null}
      {advisory ? (
        <span className={cn('block', modelTone.MODEL_ADVISORY_TEXT_CLASS)}>{advisory}</span>
      ) : null}
      {help ? (
        <span
          className={cn(
            'block',
            (issue || advisory) && 'mt-1 border-t border-black/10 pt-1 dark:border-white/10'
          )}
        >
          {help}
        </span>
      ) : null}
    </>
  );
};
