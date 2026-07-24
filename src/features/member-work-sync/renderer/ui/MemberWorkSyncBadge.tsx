import { Badge } from '@renderer/components/ui/badge';
import { cn } from '@renderer/lib/utils';

import {
  type MemberWorkSyncStatusViewModel,
  toMemberWorkSyncStatusViewModel,
} from '../view-models/memberWorkSyncStatusViewModel';

import type { MemberWorkSyncStatus } from '../../contracts';
import type React from 'react';

type MemberWorkSyncBadgeProps = Readonly<{
  status?: MemberWorkSyncStatus | null;
  viewModel?: MemberWorkSyncStatusViewModel;
  className?: string;
}>;

const toneClassName: Record<MemberWorkSyncStatusViewModel['tone'], string> = {
  neutral: 'border-[var(--color-border)] text-[var(--color-text-muted)]',
  success: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
  working: 'border-sky-500/25 bg-sky-500/10 text-sky-300',
  attention: 'border-amber-500/25 bg-amber-500/10 text-amber-200',
  blocked: 'border-red-500/25 bg-red-500/10 text-red-300',
};

export function MemberWorkSyncBadge({
  status,
  viewModel,
  className,
}: MemberWorkSyncBadgeProps): React.ReactElement {
  const resolved = viewModel ?? toMemberWorkSyncStatusViewModel(status);

  return (
    <Badge
      variant="outline"
      className={cn(
        'cursor-default whitespace-nowrap font-medium',
        toneClassName[resolved.tone],
        className
      )}
      title={resolved.tooltip}
    >
      {resolved.label}
    </Badge>
  );
}
