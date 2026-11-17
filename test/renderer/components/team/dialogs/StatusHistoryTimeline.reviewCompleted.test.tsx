import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkflowTimeline } from '@renderer/components/team/dialogs/StatusHistoryTimeline';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TaskHistoryEvent } from '@shared/types';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: ({ name }: { name: string }) => <span>{name}</span>,
}));
vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

describe('review completion in task workflow timeline', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows reviewer feedback and distinguishes AI completion from human approval', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const events: TaskHistoryEvent[] = [
      {
        id: 'request-1', type: 'review_requested', from: 'none', to: 'review',
        reviewer: 'alice', timestamp: '2026-11-16T00:00:00.000Z',
      },
      {
        id: 'complete-1', type: 'review_completed', from: 'review', to: 'reviewed',
        reviewRequestId: 'request-1', actor: 'alice',
        note: 'All requested changes verified. Ready for human acceptance.',
        timestamp: '2026-11-16T00:01:00.000Z',
      },
      {
        id: 'approve-1', type: 'human_approved', from: 'reviewed', to: 'approved',
        actor: 'user', timestamp: '2026-11-16T00:02:00.000Z',
      },
    ];
    await act(async () => {
      root.render(<WorkflowTimeline events={events} memberColorMap={new Map()} />);
      await Promise.resolve();
    });
    expect(host.textContent).toContain('taskDetail.workflowTimeline.reviewCompleted');
    expect(host.textContent).toContain('taskDetail.workflowTimeline.humanApproved');
    expect(host.textContent).toContain('All requested changes verified.');
    expect(host.textContent).not.toContain('taskDetail.workflowTimeline.unknownEvent');
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
