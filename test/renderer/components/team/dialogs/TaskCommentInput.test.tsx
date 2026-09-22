/* eslint-disable @typescript-eslint/naming-convention -- vi.mock component exports stay PascalCase. */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

const draftHarness = vi.hoisted(() => ({
  addTaskComment: vi.fn(),
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@renderer/components/chat/viewers/MarkdownViewer', () => ({
  MarkdownViewer: ({ content }: { content: string }) => React.createElement('div', null, content),
}));

vi.mock('@renderer/components/team/attachments/ImageLightbox', () => ({
  ImageLightbox: () => null,
}));

vi.mock('@renderer/components/team/editor/FileIcon', () => ({
  FileIcon: () => React.createElement('span'),
}));

vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: ({ name }: { name: string }) => React.createElement('span', null, name),
}));

vi.mock('@renderer/components/ui/MentionableTextarea', () => ({
  MentionableTextarea: ({
    surfaceClassName,
    cornerAction,
  }: {
    surfaceClassName?: string;
    cornerAction?: React.ReactNode;
  }) =>
    React.createElement(
      'div',
      { 'data-testid': 'composer-surface', className: surfaceClassName },
      cornerAction
    ),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock('@renderer/hooks/useChipDraftPersistence', () => ({
  useChipDraftPersistence: () => ({
    chips: [],
    addChip: vi.fn(),
    removeChip: vi.fn(),
    clearChipDraft: vi.fn(),
  }),
}));

vi.mock('@renderer/hooks/useDraftPersistence', () => ({
  useDraftPersistence: () => ({
    value: '',
    setValue: vi.fn(),
    isSaved: false,
    clearDraft: vi.fn(),
  }),
}));

vi.mock('@renderer/hooks/useTaskSuggestions', () => ({
  useTaskSuggestions: () => ({ suggestions: [] }),
}));

vi.mock('@renderer/hooks/useTeamSuggestions', () => ({
  useTeamSuggestions: () => ({ suggestions: [] }),
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      addTaskComment: draftHarness.addTaskComment,
      addingComment: false,
      selectedTeamData: null,
    }),
}));
/* eslint-enable @typescript-eslint/naming-convention -- End PascalCase vi.mock exports. */

import { TaskCommentInput } from '@renderer/components/team/dialogs/TaskCommentInput';

describe('TaskCommentInput composer layout', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('disconnects the reply card when an attachment error appears between it and the composer', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TaskCommentInput, {
          teamName: 'team-a',
          taskId: 'task-a',
          members: [],
          replyTo: { author: 'alice', text: 'Please update this' },
          onClearReply: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const getReplyCard = (): HTMLElement => {
      const card = [...host.querySelectorAll<HTMLElement>('div')].find((element) =>
        element.className.includes('overflow-hidden border')
      );
      if (!card) throw new Error('Reply card not found');
      return card;
    };
    const getComposerSurface = (): HTMLElement => {
      const surface = host.querySelector<HTMLElement>('[data-testid="composer-surface"]');
      if (!surface) throw new Error('Composer surface not found');
      return surface;
    };

    expect(getReplyCard().className).toContain('rounded-t-md');
    expect(getReplyCard().className).toContain('border-b-0');
    expect(getComposerSurface().className).not.toContain('message-composer-flat-body-standalone');

    const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error('File input not found');
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [new File([], 'empty.txt', { type: 'text/plain' })],
    });

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('File "empty.txt" is empty');
    expect(getReplyCard().className).toContain('rounded-md');
    expect(getReplyCard().className).toContain('mb-2');
    expect(getReplyCard().className).not.toContain('border-b-0');
    expect(getComposerSurface().className).toContain('message-composer-flat-body-standalone');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
