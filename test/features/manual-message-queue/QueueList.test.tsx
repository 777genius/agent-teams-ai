import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, expect, it, vi } from 'vitest';

import { QueueList } from '../../../src/features/manual-message-queue/renderer/ui/QueueList';
import {
  createEncodedTaskReference,
  extractTaskRefsFromText,
  stripEncodedTaskReferenceMetadata,
} from '../../../src/renderer/utils/taskReferenceUtils';

import type { QueueItem } from '../../../src/features/manual-message-queue/core/domain/queue';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key.split('.').at(-1) }),
}));
const item: QueueItem = {
  queueItemId: 'queued-1',
  revision: 2,
  position: 0,
  createdAt: 1,
  updatedAt: 1,
  scope: {
    transport: 'desktop-local-teams-v1',
    root: '/sandbox',
    contextId: 'local',
    host: null,
    teamName: 'test',
    chat: 'member',
  },
  route: { kind: 'direct', participant: 'member' },
  text: 'original',
  actionMode: 'ask',
  state: 'queued',
};
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = '';
});
function render(items = [item], onEdit = vi.fn().mockResolvedValue(undefined)) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onSend = vi.fn().mockResolvedValue(undefined),
    onRemove = vi.fn().mockResolvedValue(undefined);
  const draw = (visible: QueueItem[]) =>
    root.render(
      <TooltipProvider>
        <input aria-label="current draft" defaultValue="working draft" />
        <QueueList
          items={visible}
          busy={false}
          blockedReason={() => null}
          onEdit={onEdit}
          onSend={onSend}
          onRemove={onRemove}
          onCheck={vi.fn().mockResolvedValue(undefined)}
          onCopy={vi.fn().mockResolvedValue(undefined)}
        />
      </TooltipProvider>
    );
  act(() => draw(items));
  const button = (name: string) =>
    host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`) ??
    Array.from(host.querySelectorAll('button')).find((node) => node.textContent === name)!;
  return {
    host,
    button,
    onSend,
    onRemove,
    onEdit,
    rerender: (visible: QueueItem[]) => act(() => draw(visible)),
  };
}

it('preserves edit and working draft on CAS rejection, keeps captured Ask mode and cancels with focus', async () => {
  const reference = createEncodedTaskReference('12', 'task-12', 'test');
  const retained = createEncodedTaskReference('99', 'task-99', 'other-team');
  const referencedItem = { ...item, text: `Review ${reference} and ${retained}` };
  const view = render([referencedItem], vi.fn().mockRejectedValue(new Error('revision conflict')));
  await act(async () => view.button('edit').click());
  const editor = view.host.querySelector('textarea')!;
  const task12 = { displayId: '12', taskId: 'task-12', teamName: 'test' };
  const task13 = { displayId: '13', taskId: 'task-13', teamName: 'test' };
  const task99 = { displayId: '99', taskId: 'task-99', teamName: 'other-team' };
  for (const [changed, expected] of [
    [reference, [task12, task99]],
    [reference.replace('#12', '#13'), [task13, task99]],
    [reference.replace('#12', ''), [task99]],
  ] as const) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        editor,
        `Review ${changed} and ${retained}`
      );
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => view.button('save').click());
    const [captured, saved] = view.onEdit.mock.lastCall! as [QueueItem, string];
    expect(captured).toBe(referencedItem);
    expect(editor.value).toBe(saved);
    expect(stripEncodedTaskReferenceMetadata(saved)).toBe(
      `Review ${stripEncodedTaskReferenceMetadata(changed)} and #99`
    );
    expect(
      extractTaskRefsFromText(saved, [
        {
          id: 'task:test:task-13',
          name: '13',
          type: 'task',
          taskId: 'task-13',
          teamName: 'test',
          isCurrentTeamTask: true,
        },
      ])
    ).toEqual(expected);
    expect(saved).toContain(retained);
    expect(view.host.querySelector('[role="alert"]')?.textContent).toBe('revision conflict');
  }
  const edited = editor.value;
  expect(view.host.querySelector('input')?.value).toBe('working draft');
  expect(view.host.textContent).toContain('ask');
  view.rerender([]);
  expect(view.host.querySelector('textarea')?.value).toBe(edited);
  expect(view.host.textContent).toContain('conflict');
  await act(async () =>
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );
  expect(view.host.querySelector('textarea')).toBeNull();
  expect(view.onSend).not.toHaveBeenCalled();
});

it('uses modified Enter only to save once and ignores IME, repeat, ordinary Enter and invalid text', async () => {
  const view = render();
  await act(async () => view.button('edit').click());
  const editor = view.host.querySelector('textarea')!;
  for (const init of [{}, { ctrlKey: true, isComposing: true }, { metaKey: true, repeat: true }]) {
    await act(async () =>
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init }))
    );
  }
  expect(view.onEdit).not.toHaveBeenCalled();
  await act(async () =>
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
    )
  );
  expect(view.onEdit).toHaveBeenCalledOnce();
  expect(view.host.querySelector('textarea')).toBeNull();
  expect(document.activeElement?.tagName).toBe('LI');
  await act(async () => view.button('edit').click());
  const next = view.host.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(next, ' ');
    next.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(view.button('save').disabled).toBe(true);
  await act(async () =>
    next.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );
  expect(document.activeElement).toBe(view.button('edit'));
  expect(view.onSend).not.toHaveBeenCalled();
});

it('freezes unknown rows and explicitly removes only the record', async () => {
  const unknown = { ...item, state: 'unknown' as const };
  const view = render([unknown]);
  expect(view.button('send').disabled).toBe(true);
  expect(view.button('edit').disabled).toBe(true);
  expect(view.host.textContent).toContain('unknownWarning');
  expect(view.button('copy').disabled).toBe(false);
  expect(view.button('checkHistory').disabled).toBe(false);
  await act(async () => view.button('removeRecord').click());
  expect(view.onRemove).toHaveBeenCalledWith(unknown);
  expect(view.onSend).not.toHaveBeenCalled();
});
