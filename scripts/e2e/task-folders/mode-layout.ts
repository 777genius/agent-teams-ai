import assert from 'node:assert/strict';

import { type Fixture } from './runtime.ts';
import { folderRow, selectors, taskKeyData, taskRow, type UI } from './ui.ts';
import type { GlobalTask, TaskComment } from '../../../src/shared/types';

interface Rect { left: number; right: number; top: number; bottom: number }
interface LayoutSample {
  parts: Record<string, Rect[]>;
  card: Rect;
  panelBackground: string;
  sidebarBackground: string;
}

function sampleCardLayout(rootSelector: string, key: string): LayoutSample {
  const root = document.querySelector(rootSelector);
  const card = Array.from(root?.querySelectorAll('[data-task-key]') ?? []).find(
    (node) => node.getAttribute('data-task-key') === key
  );
  if (!card) throw new Error('Missing shared card for geometry');
  const parts: Record<string, Rect[]> = {};
  const fields = {
    status: '[data-task-card-field="status"]',
    subject: '[data-task-card-field="subject"]',
    handle: '[data-testid="sidebar-task-drag-handle"]',
    menu: '[data-testid="tree-task-actions"]',
    needsFix: '[data-task-card-field="needsFix"]',
    unread: '[data-task-card-field="unread"]',
    archived: '[aria-label="Archived task"]',
  };
  for (const [name, selector] of Object.entries(fields)) {
    const node = card.querySelector(selector);
    if (!node && ['needsFix', 'unread', 'archived'].includes(name)) continue;
    if (!node) throw new Error('Missing layout part ' + name);
    parts[name] = Array.from(node.getClientRects()).map((rect) => {
      let left = rect.left, right = rect.right, top = rect.top, bottom = rect.bottom;
      // Inline text exposes clipped line boxes; compare only its painted fragments.
      let ancestor = node.parentElement;
      while (ancestor && ancestor !== card) {
        const style = getComputedStyle(ancestor), clip = ancestor.getBoundingClientRect();
        if (['hidden', 'clip'].includes(style.overflowX)) {
          left = Math.max(left, clip.left); right = Math.min(right, clip.right);
        }
        if (['hidden', 'clip'].includes(style.overflowY)) {
          top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
        }
        ancestor = ancestor.parentElement;
      }
      return { left, right, top, bottom };
    }).filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
  }
  const backgrounds: string[] = [];
  for (const selector of ['[data-testid="task-folders-panel"]', '#sidebar-tasks-panel']) {
    let node = document.querySelector(selector);
    while (node) {
      const color = getComputedStyle(node).backgroundColor;
      if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') {
        backgrounds.push(color);
        break;
      }
      node = node.parentElement;
    }
  }
  if (backgrounds.length !== 2) throw new Error('No opaque panel/sidebar background');
  const rect = card.getBoundingClientRect();
  return {
    parts, card: {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom},
    panelBackground: backgrounds[0], sidebarBackground: backgrounds[1],
  };
}
const SAMPLE_LAYOUT = sampleCardLayout.toString().trim();
assert(!SAMPLE_LAYOUT.includes('__name('), 'Browser layout helper contains a TS runner closure');

export async function cardLayout(ui: UI, team: string, id: string, compareBackground = true) {
  await ui.point(taskRow(team, id));
  const sample = await ui.callFunction<LayoutSample>(SAMPLE_LAYOUT, [selectors.tree, taskKeyData(team, id)]);
  const overlaps = (a: Rect, b: Rect) =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
  const entries = Object.entries(sample.parts);
  for (const [index, [name, rects]] of entries.entries()) {
    assert(rects.length, `No visible rectangle for ${name}`);
    for (const rect of rects) {
      assert(rect.left >= sample.card.left - 1 && rect.right <= sample.card.right + 1,
        `${name} escaped card horizontally: ${JSON.stringify(sample)}`);
      assert(rect.top >= sample.card.top - 1 && rect.bottom <= sample.card.bottom + 1,
        `${name} escaped card vertically: ${JSON.stringify(sample)}`);
    }
    for (const [otherName, otherRects] of entries.slice(index + 1))
      assert(!rects.some((r) => otherRects.some((other) => overlaps(r, other))),
        `${name} overlaps ${otherName}: ${JSON.stringify(sample)}`);
  }
  if (compareBackground) assert.equal(sample.panelBackground, sample.sidebarBackground,
    'Folder panel and sidebar computed backgrounds differ');
  return sample;
}

export async function cardLayoutScenarios(
  ui: UI, team: string, id: string, compareBackground = true,
  screenshot?: (name: string) => Promise<void>
) {
  const normal = await cardLayout(ui, team, id, compareBackground);
  const original = await ui.value<GlobalTask[]>('window.__agentTeamsDevStore.getState().globalTasks');
  const longSubject = 'TEST long subject ' + 'Layout regression content '.repeat(12);
  const updated = original.map((task) => task.teamName === team && task.id === id
    ? { ...task, subject: longSubject, reviewState: 'needsFix' as const, status: 'in_progress' as const } : task);
  try {
    await ui.cdp.evaluate(`window.__agentTeamsDevStore.setState({globalTasks:${JSON.stringify(updated)}})`);
    await ui.wait(`${taskRow(team, id)}?.querySelector('[data-task-card-field="subject"]')?.textContent===${JSON.stringify(longSubject)}`,
      'long shared card title rendered');
    const longGeometry = await cardLayout(ui, team, id, compareBackground);
    if (screenshot) await screenshot('folder-layout-long-subject');
    return { normal, longSubject: longGeometry };
  } finally {
    await ui.cdp.evaluate(`window.__agentTeamsDevStore.setState({globalTasks:${JSON.stringify(original)}})`);
  }
}

export async function folderUnreadPropagation(
  ui: UI, f: Fixture, screenshot?: (name: string) => Promise<void>
) {
  await ui.open();
  await ui.expand(f.parent);
  await ui.expand(f.nested);
  const original = await ui.value<GlobalTask[]>('window.__agentTeamsDevStore.getState().globalTasks');
  const canonical = await ui.snapshot();
  const comment = (id: string): TaskComment => ({
    id, author: 'TEST unread author', text: 'Disposable unread',
    createdAt: new Date(Date.now() + 1000).toISOString(), type: 'regular',
  });
  const update = async (a: TaskComment[], c: TaskComment[]) => {
    const tasks = original.map((task) => task.teamName === f.team && ['a', 'c'].includes(task.id)
      ? { ...task, comments: task.id === 'a' ? a : c } : task);
    await ui.cdp.evaluate(`window.__agentTeamsDevStore.setState({globalTasks:${JSON.stringify(tasks)}})`);
  };
  const count = async (folderId: string, expected: number) => {
    await ui.locate(folderRow(folderId));
    const badge = `${folderRow(folderId)}?.querySelector('[data-testid="task-folder-unread-count"]')`;
    await ui.wait(expected > 0
      ? `${badge}?.getAttribute('data-unread-count')===${JSON.stringify(String(expected))}`
      : `!(${badge}) || ${badge}.getAttribute('data-unread-count')==='0'`,
    `folder ${folderId} has ${expected} unread tasks`);
  };
  const counts = async (parent: number, nested: number) => {
    await count(f.parent, parent);
    await count(f.nested, nested);
    assert.deepEqual(await ui.snapshot(), canonical, 'Unread actions rewrote canonical folder state');
  };
  // a was moved into parent by the filtered native move; c remains in nested.
  assert(canonical.folders.find((folder) => folder.id === f.parent)?.children.some(
    (child) => child.kind === 'task' && child.identity.taskId === 'a'));
  try {
    await update([comment('a-1'), comment('a-2'), comment('a-3')], [comment('c-1'), comment('c-2')]);
    await counts(2, 1); // Task count, never comment count.
    await ui.point(folderRow(f.nested));
    await ui.point(folderRow(f.parent));
    if (screenshot) await screenshot('folder-unread-propagation');
    await update([], [comment('c-1'), comment('c-2')]);
    await counts(1, 1);
    await update([], []);
    await counts(0, 0);
    await ui.menu(taskRow(f.team, 'c'), 'Mark as unread');
    await counts(1, 1);
    await ui.click(`${taskRow(f.team, 'c')}.querySelector('[data-testid="sidebar-task-detail"]')`);
    await ui.wait('document.querySelector(\'[role="dialog"]\')', 'unread task detail opened');
    await counts(0, 0);
    await ui.key('Escape');
    await ui.wait('!document.querySelector(\'[role="dialog"]\')', 'unread task detail closed');
    await update([], [comment('c-live')]);
    await counts(1, 1);
    return { distinctTasks: 2, comments: 5, ancestorDepth: 2, liveComments: true, manualUnreadAndRead: true };
  } finally {
    await ui.cdp.evaluate(`window.__agentTeamsDevStore.setState({globalTasks:${JSON.stringify(original)}})`);
  }
}
