import React, { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';

import { useStore } from '@renderer/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  folderController,
  panelController,
} from '../../../src/features/task-folders/renderer/composition';
import { useTaskFoldersHost } from '../../../src/features/task-folders/renderer/hooks/useTaskFoldersHost';
import { UNFILED } from '../../../src/features/task-folders/renderer/view-models/projection';
import { defaultTaskFiltersState } from '../../../src/renderer/components/sidebar/taskFiltersState';

import type { GlobalTask } from '@shared/types';

const makeGlobalTask = (overrides: Partial<GlobalTask> = {}): GlobalTask => ({
  id: '1',
  teamName: 't',
  teamDisplayName: 'Team',
  subject: 'Task',
  status: 'pending',
  ...overrides,
});

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key, resolvedLanguage: 'en' }),
}));

let captured: ReturnType<typeof useTaskFoldersHost>;

function Probe() {
  const sidebar = createRef<HTMLDivElement>();
  captured = useTaskFoldersHost('local', sidebar, false, sidebar);
  return null;
}

const unfiledActiveCount = (): number =>
  captured.canonicalProjection.nodes.get(UNFILED)?.active ?? -1;

async function setShowDeleted(showDeleted: boolean): Promise<void> {
  const filters = defaultTaskFiltersState();
  filters.showDeleted = showDeleted;
  await act(async () => captured.view.setFilters(filters));
}

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let fetchAllDeletedTasks: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  await folderController.reset();
  fetchAllDeletedTasks = vi.fn((): Promise<void> => Promise.resolve());
  useStore.setState({
    globalTasks: [makeGlobalTask()],
    globalDeletedTasks: [makeGlobalTask({ id: '2', subject: 'Deleted', status: 'deleted' })],
    fetchAllDeletedTasks,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Probe />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  panelController.dispose();
  useStore.setState({ globalTasks: [], globalDeletedTasks: [] });
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps deleted tasks out of folder counts while the deleted filter is off', () => {
  expect(unfiledActiveCount()).toBe(1);
});

it('loads deleted identities even while the filter hides them', () => {
  // Without the feed a deleted folder child resolves to an unavailable node,
  // so the hidden-row rule below never gets a chance to apply.
  expect(fetchAllDeletedTasks).toHaveBeenCalled();
});

it('counts deleted tasks once the deleted filter is enabled', async () => {
  await setShowDeleted(true);
  expect(unfiledActiveCount()).toBe(2);
  await setShowDeleted(false);
  expect(unfiledActiveCount()).toBe(1);
});
