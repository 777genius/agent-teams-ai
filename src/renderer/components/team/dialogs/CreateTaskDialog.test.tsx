import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDesktopTaskInteraction } from '../createDesktopTaskInteraction';

import { CreateTaskDialog } from './CreateTaskDialog';

import type { TeamTask } from '@shared/types';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import type { Root } from 'react-dom/client';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string) => (key === 'tasks.createTask.create' ? 'Create' : key),
  }),
}));
vi.mock('@renderer/components/ui/dialog', () => {
  const Container = ({ children }: { children?: ReactNode }): ReactNode => children;
  return {
    Dialog: Container,
    DialogContent: Container,
    DialogDescription: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogTitle: Container,
  };
});
vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children, disabled, onClick }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock('@renderer/components/ui/input', () => ({
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
vi.mock('@renderer/components/ui/label', () => ({
  Label: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@renderer/components/ui/MemberSelect', () => ({ MemberSelect: () => null }));
vi.mock('@renderer/components/ui/MentionableTextarea', () => ({ MentionableTextarea: () => null }));
vi.mock('@renderer/components/ui/tiptap', () => ({ TiptapEditor: () => null }));
vi.mock('@renderer/components/ui/checkbox', () => ({ Checkbox: () => null }));
vi.mock('@renderer/hooks/useDraftPersistence', async () => {
  const { useState } = await import('react');
  return {
    useDraftPersistence: () => {
      const [value, setValue] = useState('');
      return { value, setValue, clearDraft: () => setValue(''), isSaved: false };
    },
  };
});
vi.mock('@renderer/hooks/useChipDraftPersistence', async () => {
  const { useState } = await import('react');
  return {
    useChipDraftPersistence: () => {
      const [chips, setChips] = useState([]);
      return { chips, setChips, clearChipDraft: () => setChips([]) };
    },
  };
});
vi.mock('@renderer/hooks/useTaskSuggestions', () => ({
  useTaskSuggestions: () => ({ suggestions: [] }),
}));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: object) => unknown) => selector({}),
}));
vi.mock('@renderer/store/slices/teamSlice', () => ({
  selectTeamDataForName: () => ({ config: { projectPath: null } }),
}));

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

describe('CreateTaskDialog', () => {
  it('keeps a rich create open with explicit unverified delivery after task confirmation', async () => {
    const interaction = createDesktopTaskInteraction(
      { key: 'context/team-rich', authorityEpoch: 'epoch-1' },
      {
        teamName: 'team',
        createTask: vi.fn(
          async () => ({ id: 'task-rich', subject: 'Rich', status: 'in_progress' }) as TeamTask
        ),
        refreshCreatedTask: vi.fn(async () => undefined),
      }
    );
    const onClose = vi.fn();
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    roots.push(root);
    await act(async () => {
      root.render(
        <CreateTaskDialog
          open
          teamName="team"
          members={[]}
          tasks={[]}
          isTeamAlive
          defaultSubject="Rich"
          defaultOwner="member-a"
          defaultStartImmediately
          interaction={interaction}
          onClose={onClose}
        />
      );
    });

    await act(async () => {
      const create = [...element.querySelectorAll('button')].find(
        (button) => button.textContent === 'Create'
      );
      if (!create) throw new Error('Missing Create button');
      create.click();
    });
    expect(interaction.getSnapshot().confirmed?.coverage).toBe('task_write');
    expect(onClose).not.toHaveBeenCalled();
    expect(element.textContent).toContain(
      'Requested prompt or start delivery has not been verified'
    );
    expect(element.textContent).toContain('Continue after manual check');
    act(() => root.unmount());
    roots.pop();
    element.remove();
  });

  it('keeps an edited draft open when an exact retry confirms the original command', async () => {
    const createTask = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValueOnce({ id: 'task-a', subject: 'A', status: 'pending' } as TeamTask);
    const interaction = createDesktopTaskInteraction(
      { key: 'context/team', authorityEpoch: 'epoch-1' },
      {
        teamName: 'team',
        createTask,
        refreshCreatedTask: vi.fn(async () => undefined),
      }
    );
    const onClose = vi.fn();
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    roots.push(root);

    await act(async () => {
      root.render(
        <CreateTaskDialog
          open
          teamName="team"
          members={[]}
          tasks={[]}
          defaultSubject="A"
          defaultStartImmediately={false}
          interaction={interaction}
          onClose={onClose}
        />
      );
    });
    const button = (text: string): HTMLButtonElement => {
      const found = [...element.querySelectorAll('button')].find(
        (item) => item.textContent === text
      );
      if (!found) throw new Error(`Missing button ${text}`);
      return found;
    };
    await act(async () => button('Create').click());
    expect(interaction.getSnapshot().phase).toBe('uncertain');

    const subject = element.querySelector<HTMLInputElement>('#task-subject');
    if (!subject) throw new Error('Missing subject input');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(subject, 'B');
      subject.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(subject.value).toBe('B');

    await act(async () => button('Retry original command').click());
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(createTask.mock.calls[1]).toEqual(createTask.mock.calls[0]);
    expect(onClose).not.toHaveBeenCalled();
    expect(subject.value).toBe('B');
    expect(interaction.getSnapshot().phase).toBe('confirmed');
    act(() => root.unmount());
    roots.pop();
    element.remove();
  });
});
