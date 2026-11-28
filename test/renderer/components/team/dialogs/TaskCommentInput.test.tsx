/* eslint-disable @typescript-eslint/naming-convention -- vi.mock component exports stay PascalCase. */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { MAX_TEXT_LENGTH } from '@shared/constants';
import { afterEach, describe, expect, it, vi } from 'vitest';

const composerHarness = vi.hoisted(() => ({ realEditor: false }));

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

vi.mock('@renderer/components/ui/MentionableTextarea', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@renderer/components/ui/MentionableTextarea')
  >();
  return {
    MentionableTextarea: ({
      surfaceClassName,
      cornerAction,
      ...props
    }: React.ComponentProps<typeof actual.MentionableTextarea>) =>
      composerHarness.realEditor
        ? React.createElement(actual.MentionableTextarea, {
            ...props,
            surfaceClassName,
            cornerAction,
          })
        : React.createElement(
            'div',
            { 'data-testid': 'composer-surface', className: surfaceClassName },
            cornerAction
          ),
  };
});

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({
    theme: 'dark',
    resolvedTheme: 'dark',
    isDark: true,
    isLight: false,
    customTheme: null,
  }),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock('@renderer/hooks/useTaskSuggestions', () => ({
  useTaskSuggestions: () => ({ suggestions: [] }),
}));

vi.mock('@renderer/hooks/useTeamSuggestions', () => ({
  useTeamSuggestions: () => ({ suggestions: [] }),
}));

/* eslint-enable @typescript-eslint/naming-convention -- End PascalCase vi.mock exports. */

import { TaskCommentInput } from '@renderer/components/team/dialogs/TaskCommentInput';
import { MentionableTextarea } from '@renderer/components/ui/MentionableTextarea';

import { createTaskDetailSessionFixture } from './taskDetailSessionFixture';

describe('TaskCommentInput composer layout', () => {
  afterEach(() => {
    composerHarness.realEditor = false;
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('disconnects the reply card when an attachment error appears between it and the composer', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const View = () => {
      const [error, setError] = React.useState<string | null>(null);
      const controller = createTaskDetailSessionFixture('task-a');
      controller.session = {
        ...controller.session,
        reply: { taskId: 'task-a', author: 'alice', text: 'Please update this' },
      };
      controller.attachmentError = error;
      controller.addPendingFiles = async () => {
        setError('File "empty.txt" is empty');
      };
      return React.createElement(TaskCommentInput, {
        surfaceId: 'test-comment',
        contextId: 'local',
        teamName: 'team-a',
        taskId: 'task-a',
        projectPath: '/TEST/project',
        members: [],
        controller,
      });
    };
    await act(async () => {
      root.render(React.createElement(View));
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
  it.each([
    { name: 'cleared', text: '' },
    { name: 'over-limit', text: 'x'.repeat(MAX_TEXT_LENGTH + 1) },
  ])(
    'keeps the existing Send available to resolve a retained original comment after $name draft edits',
    async ({ text }) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      const controller = createTaskDetailSessionFixture('task-a');
      controller.session = {
        ...controller.session,
        commentText: text,
        commentIntent: {
          request: {
            text: 'ORIGINAL',
            command: { commandId: 'TEST-original', idempotencyKey: 'TEST-original' },
          },
          submittedPartRevisions: { commentText: 1 },
        },
      };
      const render = async () => {
        await act(async () => {
          root.render(
            <TaskCommentInput
              surfaceId="TEST-dialog"
              contextId="local"
              teamName="team-a"
              taskId="task-a"
              projectPath={null}
              members={[]}
              controller={controller}
            />
          );
        });
      };
      await render();
      const button = host.querySelector<HTMLButtonElement>('.message-composer-send-button')!;
      expect(button).not.toBeNull();
      expect(button.disabled).toBe(false);
      expect(host.querySelector('.message-composer-send-slot')?.getAttribute('data-visible')).toBe(
        'true'
      );
      await act(async () => {
        button.click();
      });
      expect(controller.submitComment).toHaveBeenCalledTimes(1);
      controller.canSubmit = false;
      await render();
      expect(host.querySelector<HTMLButtonElement>('.message-composer-send-button')!.disabled).toBe(
        true
      );
      await act(async () => {
        root.unmount();
      });
    }
  );

  it('keeps comment focus during owner ineligibility and disables pending submission', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    composerHarness.realEditor = true;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const controller = createTaskDetailSessionFixture('task-a');
    const render = async () => {
      await act(async () => {
        root.render(
          <TaskCommentInput
            surfaceId="TEST-dialog"
            contextId="local"
            teamName="team-a"
            taskId="task-a"
            projectPath={null}
            members={[]}
            controller={controller}
          />
        );
      });
    };
    try {
      await render();
      const input = host.querySelector('textarea');
      if (!(input instanceof HTMLTextAreaElement)) throw new Error('Task textarea not found');
      await act(async () => input.focus());
      expect(document.activeElement).toBe(input);
      const focus = vi.spyOn(input, 'focus');
      controller.isOwner = false;
      controller.canSubmit = false;
      await render();
      expect(host.querySelector('textarea')).toBe(input);
      expect(input.readOnly).toBe(true);
      expect(input.disabled).toBe(false);
      expect(document.activeElement).toBe(input);
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(controller.submitComment).not.toHaveBeenCalled();
      controller.isOwner = true;
      controller.canSubmit = true;
      await render();
      expect(host.querySelector('textarea')).toBe(input);
      expect(input.readOnly).toBe(false);
      expect(document.activeElement).toBe(input);
      expect(focus).not.toHaveBeenCalled();
      focus.mockRestore();
      controller.session = { ...controller.session, submitPending: true };
      controller.canSubmit = false;
      await render();
      expect(host.querySelector('textarea')).toBe(input);
      expect(input.disabled).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each(['input', 'enter', 'selection'] as const)(
    'does not invoke the real textarea custom %s path while read-only',
    async (mode) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      composerHarness.realEditor = true;
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      const change = vi.fn();
      const submit = vi.fn();
      const original = 'https://example.test/retained';
      try {
        await act(async () => {
          root.render(
            <MentionableTextarea
              value={original}
              onValueChange={change}
              onModEnter={submit}
              suggestions={[]}
              projectPath={null}
              readOnly
              showHint={false}
            />
          );
        });
        const input = host.querySelector('textarea');
        if (!(input instanceof HTMLTextAreaElement)) throw new Error('Real textarea not found');
        await act(async () => input.focus());
        expect(input.readOnly).toBe(true);
        expect(input.disabled).toBe(false);
        if (mode === 'input') {
          const setValue = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value'
          )?.set;
          if (!setValue) throw new Error('Native textarea value setter unavailable');
          await act(async () => {
            setValue.call(input, 'TEST unexpected input delivery');
            input.dispatchEvent(new Event('input', { bubbles: true }));
          });
        } else if (mode === 'enter') {
          await act(async () => {
            input.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
            );
          });
        } else {
          await act(async () => {
            input.setSelectionRange(8, 8);
            document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
            await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
          });
          expect(input.selectionStart).toBe(8);
          expect(input.selectionEnd).toBe(8);
        }
        expect(change).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(input);
      } finally {
        await act(async () => root.unmount());
      }
    }
  );

  it('hides the open mention picker while read-only without selection or refocus', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    composerHarness.realEditor = true;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const change = vi.fn();
    const submit = vi.fn();
    const render = async (value: string, readOnly: boolean) => {
      await act(async () => {
        root.render(
          <MentionableTextarea
            value={value}
            onValueChange={change}
            onModEnter={submit}
            suggestions={[{ id: 'alice', name: 'alice' }]}
            projectPath={null}
            readOnly={readOnly}
            showHint={false}
          />
        );
      });
    };
    try {
      await render('', false);
      const input = host.querySelector('textarea');
      if (!(input instanceof HTMLTextAreaElement)) throw new Error('Real textarea not found');
      input.style.lineHeight = '20px';
      await act(async () => input.focus());
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setValue) throw new Error('Native textarea value setter unavailable');
      await act(async () => {
        setValue.call(input, '@al');
        input.setSelectionRange(3, 3);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await render('@al', false);
      expect(change.mock.calls).toEqual([['@al']]);
      expect(host.querySelector('[role="option"]')?.textContent).toContain('alice');
      change.mockClear();
      const focus = vi.spyOn(input, 'focus');
      await render('@al', true);
      expect(host.querySelector('textarea')).toBe(input);
      expect(input.readOnly).toBe(true);
      expect(host.querySelector('[role="listbox"]')).toBeNull();
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      });
      expect(change).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(input.value).toBe('@al');
      expect(document.activeElement).toBe(input);
      focus.mockRestore();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
