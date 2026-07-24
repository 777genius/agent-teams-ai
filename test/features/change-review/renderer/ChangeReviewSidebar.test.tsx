import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ChangeReviewSidebar } from '@features/change-review/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileChangeSummary, FileEditTimeline } from '@shared/types';

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

const file: FileChangeSummary = {
  filePath: '/repo/src/a.ts',
  relativePath: 'src/a.ts',
  snippets: [
    {
      toolUseId: 'tool-a',
      filePath: '/repo/src/a.ts',
      toolName: 'Edit',
      type: 'edit',
      oldString: 'before',
      newString: 'after',
      replaceAll: false,
      timestamp: '2026-07-24T10:00:00.000Z',
      isError: false,
    },
  ],
  linesAdded: 2,
  linesRemoved: 1,
  isNewFile: false,
};
const timeline: FileEditTimeline = {
  filePath: file.filePath,
  durationMs: 1000,
  events: [
    {
      toolUseId: 'tool-a',
      toolName: 'Edit',
      timestamp: '2026-07-24T10:00:00.000Z',
      summary: 'Edited two lines',
      linesAdded: 2,
      linesRemoved: 1,
      snippetIndex: 3,
    },
  ],
};

describe('ChangeReviewSidebar', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('preserves file selection and timeline interaction contracts', () => {
    const onSelectFile = vi.fn();
    const onToggleTimeline = vi.fn();
    const onTimelineEventClick = vi.fn();

    act(() => {
      root.render(
        <ChangeReviewSidebar
          files={[file]}
          pathChangeLabels={{}}
          decisionState={{
            hunkDecisions: { [`${file.filePath}:0`]: 'accepted' },
            fileDecisions: {},
            fileChunkCounts: { [file.filePath]: 0 },
          }}
          activeFilePath={file.filePath}
          viewedSet={new Set([file.filePath])}
          onSelectFile={onSelectFile}
          timeline={timeline}
          timelineOpen
          onToggleTimeline={onToggleTimeline}
          onTimelineEventClick={onTimelineEventClick}
          activeSnippetIndex={3}
        />
      );
    });

    const fileButton = host.querySelector<HTMLButtonElement>(`[data-tree-file="${file.filePath}"]`);
    expect(fileButton).not.toBeNull();
    expect(host.textContent).toContain('Pending review');
    expect(host.textContent).not.toContain('All changes accepted');
    act(() => fileButton?.click());
    expect(onSelectFile).toHaveBeenCalledWith(file.filePath);

    const timelineToggle = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Edit Timeline (1)')
    );
    expect(timelineToggle).toBeDefined();
    act(() => timelineToggle?.click());
    expect(onToggleTimeline).toHaveBeenCalledOnce();

    const timelineEvent = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Edited two lines')
    );
    expect(timelineEvent).toBeDefined();
    act(() => timelineEvent?.click());
    expect(onTimelineEventClick).toHaveBeenCalledWith(3);
  });
});
