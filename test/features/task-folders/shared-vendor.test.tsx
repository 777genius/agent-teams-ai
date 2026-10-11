import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { useTaskLocalState } from '@renderer/hooks/useTaskLocalState';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  append,
  applyCommand,
  emptySnapshot,
} from '../../../src/features/task-folders/core/domain/folders';
import {
  folderController,
  panelController,
} from '../../../src/features/task-folders/renderer/composition';
import { FolderDialogs } from '../../../src/features/task-folders/renderer/ui/FolderDialogs';
import { FolderTree } from '../../../src/features/task-folders/renderer/ui/FolderTree';
import { projectFolders } from '../../../src/features/task-folders/renderer/view-models/projection';

import type { Snapshot } from '../../../src/features/task-folders/core/domain/folders';
import type { TaskFoldersHostModel } from '../../../src/features/task-folders/renderer/hooks/useTaskFoldersHost';
import type { GlobalTask } from '@shared/types';
// Layout is owned by Electron E2E. Render all projected rows here to exercise the real vendor state/rebuild and row interactions.
vi.mock('@tanstack/react-virtual', () => ({
  defaultRangeExtractor: () => [],
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 32 })),
    getTotalSize: () => count * 32,
    scrollToIndex: vi.fn(),
  }),
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key, resolvedLanguage: 'en' }),
}));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  panelController.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('shared task presentation and vendor external updates', () => {
  it('publishes archive, pin and rename across mounted consumers and preserves legacy keys on remount', async () => {
    function Probe({ writer }: { writer?: boolean }) {
      const local = useTaskLocalState();
      return (
        <div
          data-probe={writer ? 'writer' : 'reader'}
          data-archived={local.isArchived('t', '1')}
          data-pinned={local.isPinned('t', '1')}
          data-name={local.getRenamedSubject('t', '1')}
        >
          {writer && (
            <button
              onClick={() => {
                local.toggleArchive('t', '1');
                local.togglePin('t', '1');
                local.renameTask('t', '1', 'Edited');
              }}
            >
              change
            </button>
          )}
        </div>
      );
    }
    await act(async () =>
      root.render(
        <>
          <Probe writer />
          <Probe />
        </>
      )
    );
    await act(async () => host.querySelector('button')!.click());
    const reader = host.querySelector('[data-probe="reader"]')!;
    expect(reader.getAttribute('data-archived')).toBe('true');
    expect(reader.getAttribute('data-pinned')).toBe('true');
    expect(reader.getAttribute('data-name')).toBe('Edited');
    expect(JSON.parse(localStorage.getItem('taskArchivedIds')!)).toEqual(['t:1']);
    expect(JSON.parse(localStorage.getItem('taskPinnedIds')!)).toEqual(['t:1']);
    expect(JSON.parse(localStorage.getItem('taskRenamedSubjects')!)).toEqual({ 't:1': 'Edited' });
    await act(async () => root.render(null));
    await act(async () => root.render(<Probe />));
    expect(host.querySelector('[data-probe="reader"]')!.getAttribute('data-name')).toBe('Edited');
  });
  it('rebuilds committed external CRUD/move projections immediately without requiring collapse/expand', async () => {
    const tasks = [{ teamName: 't', id: '1', subject: 'Task' }] as GlobalTask[];
    let snapshot = applyCommand(emptySnapshot(), {
      type: 'create',
      id: 'a',
      name: 'A',
      parent: null,
    });
    let publish!: React.Dispatch<React.SetStateAction<Snapshot>>;
    function Harness() {
      const [s, set] = useState(snapshot);
      publish = set;
      const local = useTaskLocalState();
      const projection = projectFolders(s, tasks, local.isArchived, local.getRenamedSubject, true);
      const model = {
        projection,
        local,
        state: { status: 'ready', snapshot: s },
        panel: { dragSource: null },
        openTask: vi.fn(),
        markUnread: vi.fn(),
      } as unknown as TaskFoldersHostModel;
      return (
        <TooltipProvider>
          <FolderTree model={model} dialog={vi.fn()} focusRequest={null} />
        </TooltipProvider>
      );
    }
    await act(async () => root.render(<Harness />));
    expect(host.querySelector('[data-folder-id="a"]')).not.toBeNull();
    snapshot = applyCommand(snapshot, { type: 'create', id: 'b', name: 'B', parent: null });
    await act(async () => publish(snapshot));
    expect(host.querySelector('[data-folder-id="b"]')).not.toBeNull();
    for (const id of ['a', 'b'])
      await act(async () =>
        (
          host.querySelector(
            `[data-folder-id="${id}"] [aria-label="taskFolders.expand"]`
          ) as HTMLButtonElement
        ).click()
      );
    snapshot = applyCommand(snapshot, {
      type: 'moveTask',
      identity: { teamName: 't', taskId: '1' },
      parent: 'b',
      anchor: append,
    });
    await act(async () => publish(snapshot));
    expect(host.querySelectorAll('[data-task-key]')).toHaveLength(1);
    expect(host.querySelector('[data-task-key]')!.getAttribute('aria-level')).toBe('2');
    snapshot = applyCommand(snapshot, { type: 'rename', id: 'b', name: 'Renamed' });
    await act(async () => publish(snapshot));
    expect(host.querySelector('[data-folder-id="b"]')!.textContent).toContain('Renamed');
    await act(async () => (host.querySelector('[data-folder-id="b"]') as HTMLElement).click());
    snapshot = applyCommand(snapshot, { type: 'delete', id: 'b' });
    await act(async () => publish(snapshot));
    expect(host.querySelector('[data-folder-id="b"]')).toBeNull();
    expect(host.querySelector('[data-folder-id="a"]')!.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('[data-folder-id="a"]')!.getAttribute('tabindex')).toBe('0');
    expect(host.querySelectorAll('[data-task-key]')).toHaveLength(1);
  });
});

it('keeps a saving confirmation visible and held through Escape until its command settles', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(folderController, 'execute').mockImplementation(async () => {
    await gate;
    return emptySnapshot();
  });
  panelController.hold('dialog', true);
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <FolderDialogs
        action={open ? { kind: 'delete', id: 'a' } : null}
        close={() => setOpen(false)}
        projection={projectFolders(
          emptySnapshot(),
          [],
          () => false,
          () => undefined,
          true
        )}
        move={null}
        created={vi.fn()}
        renameTask={vi.fn()}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  const confirmation = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'taskFolders.deleteFolder'
  )!;
  await act(async () => confirmation.click());
  await act(async () =>
    document
      .querySelector('[role="dialog"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );
  await act(async () => vi.advanceTimersByTime(2500));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(panelController.getSnapshot().open).toBe(true);
  await act(async () => {
    release();
    await gate;
    await Promise.resolve();
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
