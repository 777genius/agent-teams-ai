import assert from 'node:assert/strict';

import { type Fixture } from './runtime.ts';
import { el, label, selectors, taskKeyData, taskRow, type UI } from './ui.ts';
import type { Snapshot } from '../../../src/features/task-folders/core/domain/folders.ts';
import type { GlobalTask, TaskComment } from '../../../src/shared/types';

export type CardScope = 'sidebar' | 'tree';

export interface CardMetadata {
  subject: string | null;
  status: string | null;
  needsFix: string | null;
  unread: string | null;
  project: string | null;
  owner: string | null;
  team: string | null;
  updated: string | null;
}

interface CardState extends CardMetadata {
  present: boolean;
  archived: boolean;
}

interface FilterSelection {
  status?: 'todo' | 'in_progress' | 'needs_fix' | 'done' | 'review' | 'approved';
  teamChoiceId?: string;
  projectChoiceId?: string;
  read?: 'all' | 'unread' | 'read';
}

const filterContentTestId = (scope: CardScope) => `${scope}-task-view-filters-content`;
const sortContentTestId = (scope: CardScope) => `${scope}-task-view-sort-content`;
const panelRoot = (scope: CardScope) => (scope === 'tree' ? selectors.panel : selectors.sidebar);
const FILTER_TEAM = 'task-folders-test-filter-team';
const TEAM_ALL_CHOICE_ID = '__all__';
const PROJECT_RESET_CHOICE_ID = '__reset__';
const taskKeyExpression = (team: string, id: string) =>
  JSON.stringify(JSON.stringify([team, id]));
const cardExpression = (scope: CardScope, team: string, id: string) =>
  `Array.from(${el(panelRoot(scope))}.querySelectorAll('[data-testid="${scope}-task-card"]')).find(e=>e.getAttribute('data-task-key')===${taskKeyExpression(team, id)})`;
const portalExpression = (testId: string) => `document.querySelector('[data-testid="${testId}"]')`;
const treeRowExpression = (id: string) =>
  `Array.from(${el(selectors.tree)}?.querySelectorAll('[role="treeitem"]') ?? []).find(e=>e.getAttribute('data-folder-id')===${JSON.stringify(id)})`;
const unfiledNameExpression = `Array.from(${el(selectors.tree)}?.querySelectorAll('span,button,[role="button"]') ?? []).find(e=>e.childElementCount===0 && e.textContent?.trim()==='Unfiled')`;
const unfiledRowExpression = `(${unfiledNameExpression})?.closest('[role="treeitem"]')`;

const fakeComment = (id: string): TaskComment => ({
  id,
  author: 'TEST filter commenter',
  text: 'Disposable unread comment',
  createdAt: '2026-01-01T00:00:00.000Z',
  type: 'regular',
});

function waitCardArchiveStateInBrowser(
  rootSelector: string,
  cardSelector: string,
  taskKey: string,
  archived: boolean
): boolean {
  const root = document.querySelector(rootSelector);
  const card = Array.from(root?.querySelectorAll(cardSelector) ?? []).find(
    (element) => element.getAttribute('data-task-key') === taskKey
  );
  if (!card) return false;
  const style = window.getComputedStyle(card);
  return archived
    ? card.classList.contains('opacity-60') && !!style && Number(style.opacity) < 1
    : !card.classList.contains('opacity-60') && !!style && Number(style.opacity) >= 1;
}

function restoreTaskPreferencesInBrowser(values: Record<string, string | null>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    window.dispatchEvent(new StorageEvent('storage', { key }));
  }
}

function waitLoadedTaskDetailInBrowser(
  subject: string,
  taskLabel: string,
  description: string
): boolean {
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
  if (dialogs.length !== 1) return false;
  const dialog = dialogs[0];
  if (dialog.querySelector('[role="alert"],[role="status"]')) return false;
  const heading = dialog.querySelector('h2')?.textContent?.trim();
  const content = dialog.querySelector('[data-task-detail-content]');
  if (!content) return false;
  const leaves = Array.from(content.querySelectorAll('*'))
    .filter(
      (element) =>
        element.childElementCount === 0 &&
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    )
    .map((element) => element.textContent?.trim());
  return (
    heading === subject &&
    leaves.includes(taskLabel) &&
    Array.from(content.querySelectorAll('section')).some((section) =>
      Array.from(section.querySelectorAll('*')).some(
        (element) =>
          element.childElementCount === 0 &&
          element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
          element.textContent?.trim() === description
      )
    )
  );
}

const WAIT_CARD_ARCHIVE_STATE = waitCardArchiveStateInBrowser.toString();
const RESTORE_TASK_PREFERENCES = restoreTaskPreferencesInBrowser.toString();
const WAIT_LOADED_TASK_DETAIL = waitLoadedTaskDetailInBrowser.toString();
const FRAME_SHARED_CARDS = `
  async function frameSharedCardsInBrowser(
    treeRoot,
    treeCardSelector,
    sidebarRoot,
    sidebarCardSelector,
    taskKey,
    requiredFields
  ) {
    const find = (rootSelector, cardSelector) =>
      Array.from(document.querySelector(rootSelector)?.querySelectorAll(cardSelector) ?? []).find(
        (element) => element.getAttribute('data-task-key') === taskKey
      );
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return (
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= innerHeight &&
        rect.right <= innerWidth
      );
    };
    const ready = (cards) =>
      cards.every((card) => {
        const textReady = Object.entries(requiredFields).every(([field, expected]) => {
          const element = card.querySelector('[data-task-card-field="' + field + '"]');
          return !!element && visible(element) && element.textContent?.trim() === expected;
        });
        const status = card.querySelector('[data-task-card-field="status"]');
        const statusReady =
          !!status &&
          visible(status) &&
          !!(
            status.getAttribute('data-task-card-value')?.trim() ||
            status.getAttribute('aria-label')?.trim()
          );
        const markerReady = ['needsFix', 'unread'].every((field) => {
          const element = card.querySelector('[data-task-card-field="' + field + '"]');
          if (!element) return true;
          const rect = element.getBoundingClientRect();
          return (
            visible(element) &&
            !!(
              element.getAttribute('data-task-card-value')?.trim() ||
              element.getAttribute('aria-label')?.trim() ||
              element.textContent?.trim() ||
              (rect.width > 0 && rect.height > 0)
            )
          );
        });
        return textReady && statusReady && markerReady;
      });
    const frameCard = (card) => {
      card.scrollIntoView({ block: 'center', inline: 'center' });
      for (
        let ancestor = card.parentElement;
        ancestor && ancestor !== document.body;
        ancestor = ancestor.parentElement
      ) {
        const ancestorRect = ancestor.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const overflowX =
          cardRect.left < ancestorRect.left
            ? cardRect.left - ancestorRect.left
            : Math.max(0, cardRect.right - ancestorRect.right);
        const overflowY =
          cardRect.top < ancestorRect.top
            ? cardRect.top - ancestorRect.top
            : Math.max(0, cardRect.bottom - ancestorRect.bottom);
        if (overflowX) ancestor.scrollLeft += overflowX;
        if (overflowY) ancestor.scrollTop += overflowY;
      }
      const viewportRect = card.getBoundingClientRect();
      window.scrollBy(
        viewportRect.left < 0
          ? viewportRect.left
          : Math.max(0, viewportRect.right - innerWidth),
        viewportRect.top < 0
          ? viewportRect.top
          : Math.max(0, viewportRect.bottom - innerHeight)
      );
    };

    for (let frame = 0; frame < 8; frame++) {
      const cards = [find(treeRoot, treeCardSelector), find(sidebarRoot, sidebarCardSelector)];
      if (cards.some((card) => !card)) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        continue;
      }
      cards.forEach(frameCard);
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const reacquired = [find(treeRoot, treeCardSelector), find(sidebarRoot, sidebarCardSelector)];
      if (
        reacquired.every((card) => !!card) &&
        ready(reacquired) &&
        reacquired.every((card) => visible(card))
      )
        return true;
    }
    return false;
  }
`.trim();

const fakeTask = (
  id: string,
  fields: Partial<GlobalTask> & Pick<GlobalTask, 'status'>
): GlobalTask => ({
  id,
  subject: `TEST filter ${id}`,
  description: 'Disposable filter-only task',
  teamName: FILTER_TEAM,
  teamDisplayName: 'TEST filter team',
  owner: 'filter-owner',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  blocks: [],
  blockedBy: [],
  comments: [],
  ...fields,
});

async function readCard(
  ui: UI,
  scope: CardScope,
  team: string,
  id: string
): Promise<CardState> {
  return await ui.value<CardState>(`(() => {
    const card=${cardExpression(scope, team, id)};
    const style=card ? window.getComputedStyle(card) : null;
    const text=(field)=>card?.querySelector('[data-task-card-field="'+field+'"]')?.textContent?.trim() ?? null;
    const status=card?.querySelector('[data-task-card-field="status"]');
    const needsFix=card?.querySelector('[data-task-card-field="needsFix"]');
    const unread=card?.querySelector('[data-task-card-field="unread"]');
    return {
      present:!!card,
      subject:text('subject'),
      status:status?.getAttribute('data-task-card-value') ?? status?.getAttribute('aria-label') ?? text('status'),
      needsFix:needsFix ? (needsFix.getAttribute('data-task-card-value') || needsFix.textContent?.trim() || 'needsFix') : null,
      unread:unread ? (unread.textContent?.trim() || 'unread') : null,
      project:text('project'),
      owner:text('owner'),
      team:text('team'),
      updated:text('updated'),
      archived:!!card && !!style && card.classList.contains('opacity-60') && Number(style.opacity)<1,
    };
  })()`);
}

async function expectCard(
  ui: UI,
  scope: CardScope,
  team: string,
  id: string,
  expected: Partial<CardMetadata & { archived: boolean }>
) {
  await ui.locate(scope === 'tree' ? taskRow(team, id) : cardExpression(scope, team, id));
  await ui.wait(cardExpression(scope, team, id), `${scope} shared card ${id}`);
  const state = await readCard(ui, scope, team, id);
  assert(state.present, `${scope} shared card disappeared: ${id}`);
  for (const [field, value] of Object.entries(expected))
    assert.equal(state[field as keyof CardState], value, `${scope} shared card ${id} ${field}`);
}

async function waitCardArchiveState(
  ui: UI,
  scope: CardScope,
  team: string,
  id: string,
  archived: boolean
) {
  await ui.waitFunction(
    WAIT_CARD_ARCHIVE_STATE,
    [
      panelRoot(scope),
      `[data-testid="${scope}-task-card"]`,
      taskKeyData(team, id),
      archived,
    ],
    `${scope} shared card ${id} ${archived ? 'archived grey' : 'active ungrey'}`
  );
}

async function frameSharedCards(
  ui: UI,
  f: Fixture,
  requiredFields: Record<string, string>
) {
  await ui.waitFunction(
    FRAME_SHARED_CARDS,
    [
      panelRoot('tree'),
      '[data-testid="tree-task-card"]',
      panelRoot('sidebar'),
      '[data-testid="sidebar-task-card"]',
      taskKeyData(f.team, 'a'),
      requiredFields,
    ],
    'same shared task and metadata framed in both panes'
  );
}

async function fakeCardIds(ui: UI, scope: CardScope) {
  return await ui.value<string[]>(
    `Array.from(${el(panelRoot(scope))}.querySelectorAll('[data-testid="${scope}-task-card"]'))
      .map(e=>JSON.parse(e.getAttribute('data-task-key')))
      .filter(([team])=>team===${JSON.stringify(FILTER_TEAM)})
      .map(([,id])=>id)`
  );
}

async function expandTreeAncestors(ui: UI, folderIds: string[]) {
  for (const id of folderIds) {
    await ui.locate(treeRowExpression(id));
    const expand = label('Expand folder', treeRowExpression(id));
    if (await ui.value(`!!(${expand})`)) await ui.click(expand);
  }
}

async function expandUnfiled(ui: UI) {
  await ui.locate(unfiledRowExpression);
  const expand = label('Expand folder', unfiledRowExpression);
  if (await ui.value(`!!(${expand})`)) await ui.click(expand);
}

async function openScopedSort(
  ui: UI,
  scope: CardScope,
  mode: 'time' | 'unread' | 'manual'
) {
  await ui.click(`${el(panelRoot(scope))}.querySelector('[data-testid="${scope}-task-view-sort"]')`);
  const content = portalExpression(sortContentTestId(scope));
  await ui.wait(content, `${scope} sort popover`);
  await ui.click(`${content}.querySelector('[data-sort-option="${mode}"]')`);
  await ui.wait(`!${content}`, `${scope} sort popover close`);
}

async function setSidebarGrouping(ui: UI, mode: 'none' | 'project' | 'time') {
  const trigger = `${el(selectors.sidebar)}.querySelector('[aria-label="Group by"]')`;
  await ui.click(trigger);
  const popoverId = await ui.value<string>(`${trigger}.getAttribute('aria-controls')`);
  assert(popoverId, 'Sidebar grouping popover did not bind to its trigger');
  const content = `document.getElementById(${JSON.stringify(popoverId)})`;
  await ui.wait(content, 'portaled sidebar grouping popover');
  await ui.click(
    `Array.from(${content}.querySelectorAll('button')).find(e=>e.textContent?.trim()===${JSON.stringify(
      mode === 'none' ? 'None' : mode === 'time' ? 'Time' : 'Project'
    )})`
  );
  await ui.wait(`!${content}`, 'sidebar grouping popover close');
}

async function sidebarGrouping(ui: UI): Promise<'none' | 'project' | 'time'> {
  const mode = await ui.value<string | null>(`localStorage.getItem('sidebarTasksGrouping')`);
  return mode === 'none' || mode === 'project' || mode === 'time' ? mode : 'project';
}

function scopedComboboxSettledExpression(content: string, popupId: string) {
  return `(async()=>{const popupId=${JSON.stringify(popupId)};const content=${content};
    const triggers=Array.from(content?.querySelectorAll('[role="combobox"]') ?? []);
    const trigger=triggers.filter(e=>e.getAttribute('aria-controls')===popupId);
    const sample=()=>{
      if(trigger.length!==1 || document.getElementById(popupId)) return null;
      const target=trigger[0];const rect=target.getBoundingClientRect();
      if(target.getAttribute('aria-expanded')!=='false' || target.getAttribute('data-state')!=='closed' ||
        document.activeElement!==target || !target.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) ||
        rect.width<=0 || rect.height<=0) return null;
      return [rect.x,rect.y,rect.width,rect.height];
    };
    let previous=sample();if(!previous)return false;
    for(let frame=0;frame<4;frame++){
      await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
      const current=sample();
      if(!current || current.some((value,index)=>value!==previous[index]))return false;
      previous=current;
    }
    return true;})()`;
}

async function comboboxOption(ui: UI, content: string, choiceId: string) {
  await ui.wait(
    `Array.from(${content}.querySelectorAll('[role="combobox"]')).some(e=>e.getAttribute('aria-expanded')==='true')`,
    'scoped combobox open'
  );
  const trigger = await ui.value<string>(
    `Array.from(${content}.querySelectorAll('[role="combobox"]')).find(e=>e.getAttribute('aria-expanded')==='true')?.getAttribute('aria-controls')`
  );
  assert(trigger, 'Scoped combobox did not open');
  const popup = `document.getElementById(${JSON.stringify(trigger)})`;
  const listbox = `${popup}?.querySelector('[cmdk-list][role="listbox"]')`;
  await ui.wait(`${listbox}?.querySelector('[role="option"]')`, 'portaled combobox options');
  await ui.click(
    `Array.from(${listbox}.querySelectorAll('[role="option"]')).find(e=>e.getAttribute('data-value')===${JSON.stringify(choiceId)})`
  );
  await ui.wait(`!${popup}`, 'combobox options close');
  await ui.wait(
    scopedComboboxSettledExpression(content, trigger),
    'combobox trigger focus and layout cleanup settled'
  );
}

async function openScopedFilters(ui: UI, scope: CardScope) {
  await ui.click(
    `${el(panelRoot(scope))}.querySelector('[data-testid="${scope}-task-view-filters"]')`
  );
  const content = portalExpression(filterContentTestId(scope));
  await ui.wait(content, `${scope} filter popover`);
  return content;
}

function statusesSelected(content: string, all: boolean) {
  return `(() => {const items=Array.from(${content}.querySelectorAll('[data-status-filter]'));const selected=items.filter(e=>e.getAttribute('aria-checked')==='true' || e.getAttribute('data-state')==='checked');return ${all ? 'items.length===6 && selected.length===items.length' : 'selected.length>0'};})()`;
}

const selectedStatusCount = (content: string) =>
  `Array.from(${content}.querySelectorAll('[data-status-filter]')).filter(e=>e.getAttribute('aria-checked')==='true' || e.getAttribute('data-state')==='checked').length`;

async function setStatusSelection(
  ui: UI,
  content: string,
  status?: FilterSelection['status']
) {
  const selectAll = `${content}.querySelector('[data-filter-select-all]')`;
  const allSelected = await ui.value<boolean>(statusesSelected(content, true));
  if (status) {
    if (allSelected) await ui.click(selectAll);
    else {
      await ui.click(selectAll);
      await ui.wait(statusesSelected(content, true), 'all status filters selected');
      await ui.click(selectAll);
    }
    await ui.wait(`!(${statusesSelected(content, true)})`, 'status filter draft cleared');
    assert.equal(
      await ui.value<number>(selectedStatusCount(content)),
      0,
      'empty status filter did not render as an explicit empty selection'
    );
    await ui.click(`${content}.querySelector('[data-status-filter="${status}"]')`);
    await ui.wait(
      `${content}.querySelector('[data-status-filter="${status}"]')?.getAttribute('aria-checked')==='true' || ${content}.querySelector('[data-status-filter="${status}"]')?.getAttribute('data-state')==='checked'`,
      'status filter selected'
    );
    return;
  }
  if (!allSelected) {
    await ui.click(selectAll);
    await ui.wait(statusesSelected(content, true), 'all status filters restored');
  }
}

async function applyFilters(ui: UI, scope: CardScope, selection: FilterSelection) {
  const content = await openScopedFilters(ui, scope);
  await setStatusSelection(ui, content, selection.status);
  if (selection.teamChoiceId) {
    await ui.click(`${content}.querySelectorAll('[role="combobox"]')[0]`);
    await comboboxOption(ui, content, selection.teamChoiceId);
  }
  if (selection.projectChoiceId) {
    await ui.click(`${content}.querySelectorAll('[role="combobox"]')[1]`);
    await comboboxOption(ui, content, selection.projectChoiceId);
  }
  if (selection.read)
    await ui.click(`${content}.querySelector('[data-read-filter="${selection.read}"]')`);
  await ui.click(label('Apply', content));
  await ui.wait(`!${content}`, `${scope} filter popover close`);
}

async function restoreSidebarFilters(ui: UI) {
  const content = await openScopedFilters(ui, 'sidebar');
  await setStatusSelection(ui, content);
  await ui.click(`${content}.querySelectorAll('[role="combobox"]')[0]`);
  await comboboxOption(ui, content, TEAM_ALL_CHOICE_ID);
  await ui.click(`${content}.querySelectorAll('[role="combobox"]')[1]`);
  await comboboxOption(ui, content, PROJECT_RESET_CHOICE_ID);
  await ui.click(`${content}.querySelector('[data-read-filter="all"]')`);
  await ui.click(label('Apply', content));
  await ui.wait(`!${content}`, 'sidebar filter popover close');
}

async function resetTreePreferences(ui: UI) {
  await ui.click(`${el(selectors.panel)}.querySelector('[aria-label="Clear all"]')`);
  await ui.wait(
    `${el(selectors.panel)}.querySelector('[data-testid="tree-task-view-sort"]')?.textContent?.includes('Manual order')`,
    'tree preferences reset'
  );
}

async function sandboxUpdate(ui: UI, patch: Record<string, unknown>) {
  await ui.cdp.evaluate(`window.__agentTeamsDevStore.setState(${JSON.stringify(patch)})`);
}

async function storeSnapshot(ui: UI) {
  await ui.wait(
    `window.__agentTeamsDevStore.getState().projectsLoading===false`,
    'project catalog load settled before store snapshot'
  );
  return await ui.value<{
    globalTasks: GlobalTask[];
    teams: unknown[];
    projects: unknown[];
    viewMode: string;
    projectsInitialized: boolean;
    projectsLoading: boolean;
    projectsError: string | null;
  }>(
    `(() => {const s=window.__agentTeamsDevStore.getState();return {globalTasks:s.globalTasks,teams:s.teams,projects:s.projects,viewMode:s.viewMode,projectsInitialized:s.projectsInitialized,projectsLoading:s.projectsLoading,projectsError:s.projectsError};})()`
  );
}

async function localTaskPreferences(ui: UI) {
  return await ui.value<Record<string, string | null>>(`(() => ({
    taskRenamedSubjects:localStorage.getItem('taskRenamedSubjects'),
    taskArchivedIds:localStorage.getItem('taskArchivedIds'),
    taskPinnedIds:localStorage.getItem('taskPinnedIds'),
    taskPinnedProjectKeys:localStorage.getItem('taskPinnedProjectKeys'),
    sidebarTasksGrouping:localStorage.getItem('sidebarTasksGrouping'),
    sidebarTasksSort:localStorage.getItem('sidebarTasksSort'),
    ...Object.fromEntries(Object.keys(localStorage)
      .filter(key=>key.startsWith('taskFolders:taskView:v1:'))
      .map(key=>[key,localStorage.getItem(key)])),
  }))()`);
}

async function restoreTaskPreferences(ui: UI, values: Record<string, string | null>) {
  await ui.callFunction(RESTORE_TASK_PREFERENCES, [values]);
}

export async function sharedCardParity(
  ui: UI,
  f: Fixture,
  screenshot: (name: string) => Promise<void>
) {
  const originalPreferences = await localTaskPreferences(ui);
  const originalGrouping = await sidebarGrouping(ui);
  await setSidebarGrouping(ui, 'time');
  await expandTreeAncestors(ui, [f.parent, f.nested]);
  const original = await ui.value<GlobalTask>(
    `window.__agentTeamsDevStore.getState().globalTasks.find(t=>t.teamName===${JSON.stringify(f.team)} && t.id==='a')`
  );
  const updated: GlobalTask = {
    ...original,
    subject: 'TEST shared card subject',
    status: 'in_progress',
    reviewState: 'needsFix',
    owner: 'shared-owner',
    projectPath: f.project,
    comments: [fakeComment('shared-card-comment')],
    updatedAt: '2026-02-03T04:05:06.000Z',
  };
  await sandboxUpdate(ui, {
    globalTasks: (
      await ui.value<GlobalTask[]>('window.__agentTeamsDevStore.getState().globalTasks')
    ).map((task) => (task.teamName === f.team && task.id === 'a' ? updated : task)),
  });
  await ui.menu(taskRow(f.team, 'a'), 'Pin');
  const expected: Partial<CardMetadata & { archived: boolean }> = {
    subject: 'TEST shared card subject',
    status: 'in_progress',
    needsFix: 'needsFix',
    unread: 'unread',
    owner: 'shared-owner',
    team: f.team,
    project: 'TEST-project',
  };
  await expectCard(ui, 'tree', f.team, 'a', expected);
  await expectCard(ui, 'sidebar', f.team, 'a', expected);
  const treeCard = await readCard(ui, 'tree', f.team, 'a');
  const sidebarCard = await readCard(ui, 'sidebar', f.team, 'a');
  assert.deepEqual(treeCard, sidebarCard, 'tree/sidebar shared card metadata diverged');
  for (const field of [...Object.keys(expected), 'updated'])
    assert(
      treeCard[field as keyof CardState] !== null,
      `shared card metadata was not rendered: ${field}`
    );
  const requiredFields = {
    subject: treeCard.subject,
    project: treeCard.project,
    owner: treeCard.owner,
    team: treeCard.team,
    updated: treeCard.updated,
  };
  assert(
    Object.values(requiredFields).every((value): value is string => !!value),
    'shared card visible text metadata was incomplete before screenshot framing'
  );
  await frameSharedCards(ui, f, requiredFields as Record<string, string>);
  assert.deepEqual(
    await readCard(ui, 'tree', f.team, 'a'),
    await readCard(ui, 'sidebar', f.team, 'a'),
    'shared card metadata diverged during screenshot framing'
  );
  await screenshot('shared-cards-live');
  await ui.menu(taskRow(f.team, 'a'), 'Unpin');
  await sandboxUpdate(ui, {
    globalTasks: (
      await ui.value<GlobalTask[]>('window.__agentTeamsDevStore.getState().globalTasks')
    ).map((task) => (task.teamName === f.team && task.id === 'a' ? original : task)),
  });
  await setSidebarGrouping(ui, originalGrouping);
  await restoreTaskPreferences(ui, originalPreferences);
  return {
    fields: treeCard,
    updatedAt: updated.updatedAt,
    equivalentPinnedTeamMetadata: true,
  };
}

export async function sharedCardLiveUpdates(ui: UI, f: Fixture) {
  const originalPreferences = await localTaskPreferences(ui);
  const originalGrouping = await sidebarGrouping(ui);
  await setSidebarGrouping(ui, 'time');
  await expandTreeAncestors(ui, [f.parent, f.nested]);
  const beforeTime = (await readCard(ui, 'tree', f.team, 'a')).updated;
  const original = await ui.value<GlobalTask>(
    `window.__agentTeamsDevStore.getState().globalTasks.find(t=>t.teamName===${JSON.stringify(f.team)} && t.id==='a')`
  );
  const updated: GlobalTask = {
    ...original,
    subject: 'TEST live updates',
    status: 'in_progress',
    reviewState: 'needsFix',
    owner: 'live-owner',
    projectPath: f.project,
    comments: [fakeComment('live-comment')],
    updatedAt: '2026-02-04T05:06:07.000Z',
  };
  await sandboxUpdate(ui, {
    globalTasks: (
      await ui.value<GlobalTask[]>('window.__agentTeamsDevStore.getState().globalTasks')
    ).map((task) => (task.teamName === f.team && task.id === 'a' ? updated : task)),
  });
  await expectCard(ui, 'tree', f.team, 'a', {
    subject: 'TEST live updates',
    status: 'in_progress',
    needsFix: 'needsFix',
    unread: 'unread',
    owner: 'live-owner',
  });
  await expectCard(ui, 'sidebar', f.team, 'a', {
    subject: 'TEST live updates',
    status: 'in_progress',
    needsFix: 'needsFix',
    unread: 'unread',
    owner: 'live-owner',
  });
  const updatedTreeCard = await readCard(ui, 'tree', f.team, 'a');
  const updatedSidebarCard = await readCard(ui, 'sidebar', f.team, 'a');
  assert.notEqual(updatedTreeCard.updated, beforeTime, 'updatedAt did not change in tree card');
  assert.equal(
    updatedTreeCard.updated,
    updatedSidebarCard.updated,
    'updatedAt did not propagate to sidebar card'
  );
  const commentsCleared: GlobalTask = { ...updated, comments: [] };
  await sandboxUpdate(ui, {
    globalTasks: (
      await ui.value<GlobalTask[]>('window.__agentTeamsDevStore.getState().globalTasks')
    ).map((task) =>
      task.teamName === f.team && task.id === 'a' ? commentsCleared : task
    ),
  });
  await expectCard(ui, 'tree', f.team, 'a', { unread: null });
  await expectCard(ui, 'sidebar', f.team, 'a', { unread: null });
  await ui.menu(taskRow(f.team, 'a'), 'Rename');
  await ui.fill(el('[role="dialog"] input'), 'TEST renamed live');
  await ui.key('Enter');
  await expectCard(ui, 'tree', f.team, 'a', { subject: 'TEST renamed live' });
  await expectCard(ui, 'sidebar', f.team, 'a', { subject: 'TEST renamed live' });
  await ui.menu(taskRow(f.team, 'a'), 'Mark as unread');
  await expectCard(ui, 'tree', f.team, 'a', { unread: 'unread' });
  await expectCard(ui, 'sidebar', f.team, 'a', { unread: 'unread' });
  const beforeArchive = await ui.snapshot();
  await ui.menu(taskRow(f.team, 'a'), 'Archive');
  await waitCardArchiveState(ui, 'tree', f.team, 'a', true);
  await ui.click(
    `${el(selectors.sidebar)}.querySelector('button svg.lucide-archive')?.parentElement`
  );
  await ui.wait(
    cardExpression('sidebar', f.team, 'a'),
    'sidebar archived view exposes archived shared card'
  );
  await waitCardArchiveState(ui, 'sidebar', f.team, 'a', true);
  await expectCard(ui, 'tree', f.team, 'a', { archived: true });
  await expectCard(ui, 'sidebar', f.team, 'a', { archived: true });
  assert.deepEqual(await ui.snapshot(), beforeArchive, 'Archive must not rewrite canonical folder membership');
  await ui.menu(taskRow(f.team, 'a'), 'Unarchive');
  await waitCardArchiveState(ui, 'tree', f.team, 'a', false);
  await ui.click(
    `${el(selectors.sidebar)}.querySelector('button svg.lucide-archive')?.parentElement`
  );
  await ui.wait(
    cardExpression('sidebar', f.team, 'a'),
    'sidebar active view restores unarchived shared card'
  );
  await waitCardArchiveState(ui, 'sidebar', f.team, 'a', false);
  await expectCard(ui, 'tree', f.team, 'a', { archived: false });
  await expectCard(ui, 'sidebar', f.team, 'a', { archived: false });
  assert.deepEqual(await ui.snapshot(), beforeArchive, 'Unarchive must not rewrite canonical folder membership');
  await ui.click(`${cardExpression('tree', f.team, 'a')}?.querySelector('[data-testid="sidebar-task-detail"]')`);
  await ui.waitFunction(
    WAIT_LOADED_TASK_DETAIL,
    ['TEST task a', '#a', 'Disposable task only'],
    'canonical shared task detail for task a'
  );
  await ui.key('Escape');
  await ui.wait('!document.querySelector(\'[role="dialog"]\')', 'shared task detail close');
  await sandboxUpdate(ui, {
    globalTasks: (
      await ui.value<GlobalTask[]>('window.__agentTeamsDevStore.getState().globalTasks')
    ).map((task) => (task.teamName === f.team && task.id === 'a' ? original : task)),
  });
  await setSidebarGrouping(ui, originalGrouping);
  await restoreTaskPreferences(ui, originalPreferences);
  return {
    rename: 'TEST renamed live',
    markUnread: true,
    archive: true,
    canonicalSnapshotStable: true,
  };
}

export async function scopedSortAndFilters(ui: UI, f: Fixture) {
  const originalPreferences = await localTaskPreferences(ui);
  const originalGrouping = await sidebarGrouping(ui);
  const before = await ui.snapshot();
  const original = await storeSnapshot(ui);
  await setSidebarGrouping(ui, 'none');
  const fakeTeam = FILTER_TEAM;
  const readTask = fakeTask('fake-read', {
    status: 'pending',
    projectPath: f.project,
    updatedAt: '2026-02-02T00:00:00.000Z',
  });
  const unreadTask = fakeTask('fake-unread', {
    status: 'completed',
    projectPath: `${f.project}-other`,
    updatedAt: '2026-02-01T00:00:00.000Z',
    comments: [fakeComment('filter-comment')],
  });
  // Keep this disposable catalog small enough that both cards are mounted. The
  // complete pre-test store is restored below, so no fixture task can be hidden
  // by virtualization or left out of the final equality check.
  await sandboxUpdate(ui, {
    globalTasks: [readTask, unreadTask],
    teams: [...original.teams, { teamName: fakeTeam, displayName: 'TEST filter team' }],
    projects: [
      ...original.projects,
      { path: f.project, name: 'TEST-project', sessions: [], totalSessions: 1 },
    ],
    projectsInitialized: true,
    viewMode: 'flat',
  });
  await expandUnfiled(ui);
  const sidebarBefore = await fakeCardIds(ui, 'sidebar');
  assert.deepEqual(sidebarBefore, ['fake-read', 'fake-unread']);
  await openScopedSort(ui, 'tree', 'time');
  assert.deepEqual(await fakeCardIds(ui, 'tree'), ['fake-read', 'fake-unread']);
  assert.deepEqual(await fakeCardIds(ui, 'sidebar'), sidebarBefore);
  await openScopedSort(ui, 'tree', 'unread');
  assert.deepEqual(await fakeCardIds(ui, 'tree'), ['fake-unread', 'fake-read']);
  assert.deepEqual(await fakeCardIds(ui, 'sidebar'), sidebarBefore);
  await openScopedSort(ui, 'sidebar', 'unread');
  assert.deepEqual(await fakeCardIds(ui, 'sidebar'), ['fake-unread', 'fake-read']);
  assert.deepEqual(await fakeCardIds(ui, 'tree'), ['fake-unread', 'fake-read']);
  for (const scope of ['tree', 'sidebar'] as const) {
    const other = scope === 'tree' ? 'sidebar' : 'tree';
    const otherBefore = await fakeCardIds(ui, other);
    await applyFilters(ui, scope, { status: 'done' });
    assert.deepEqual(await fakeCardIds(ui, scope), ['fake-unread']);
    assert.deepEqual(await fakeCardIds(ui, other), otherBefore);
    await applyFilters(ui, scope, { teamChoiceId: FILTER_TEAM, status: 'todo' });
    assert.deepEqual(await fakeCardIds(ui, scope), ['fake-read']);
    assert.deepEqual(await fakeCardIds(ui, other), otherBefore);
    await applyFilters(ui, scope, {
      teamChoiceId: FILTER_TEAM,
      projectChoiceId: f.project,
      status: 'todo',
    });
    assert.deepEqual(await fakeCardIds(ui, scope), ['fake-read']);
    assert.deepEqual(await fakeCardIds(ui, other), otherBefore);
    await applyFilters(ui, scope, {
      teamChoiceId: FILTER_TEAM,
      projectChoiceId: f.project,
      status: 'todo',
      read: 'unread',
    });
    assert.deepEqual(await fakeCardIds(ui, scope), []);
    assert.deepEqual(await fakeCardIds(ui, other), otherBefore);
    if (scope === 'tree') {
      await resetTreePreferences(ui);
      assert.deepEqual(await fakeCardIds(ui, 'tree'), ['fake-read', 'fake-unread']);
      assert.deepEqual(await fakeCardIds(ui, 'sidebar'), otherBefore);
    } else {
      await openScopedSort(ui, 'sidebar', 'time');
      await restoreSidebarFilters(ui);
      assert.deepEqual(await fakeCardIds(ui, 'sidebar'), ['fake-read', 'fake-unread']);
      assert.deepEqual(await fakeCardIds(ui, 'tree'), otherBefore);
    }
  }
  assert.deepEqual(await ui.snapshot(), before, 'View changes wrote canonical task folders');
  await sandboxUpdate(ui, original);
  await setSidebarGrouping(ui, originalGrouping);
  await restoreTaskPreferences(ui, originalPreferences);
  assert.deepEqual(await storeSnapshot(ui), original, 'Filter-only sandbox data was not reset');
  return {
    sorts: ['time', 'unread'],
    filters: ['status', 'team', 'project', 'read'],
    isolatedContainers: true,
    emptyStatusContract: true,
    canonicalSnapshotUnchanged: true,
  };
}

export async function filteredSidebarNativeMove(ui: UI, f: Fixture, before: Snapshot) {
  const originalPreferences = await localTaskPreferences(ui);
  await expandTreeAncestors(ui, [f.parent, f.nested]);
  await applyFilters(ui, 'tree', { read: 'unread' });
  assert.equal(
    await ui.value(`!!${cardExpression('tree', f.team, 'a')}`),
    false,
    'tree filter should hide the sidebar drag source'
  );
  assert.equal(
    await ui.value(`!!${cardExpression('sidebar', f.team, 'a')}`),
    true,
    'sidebar drag source must remain visible'
  );
  const source = `${cardExpression('sidebar', f.team, 'a')}.querySelector('[data-testid="sidebar-task-drag-handle"]')`;
  const data = await ui.beginDrag(source, { teamName: f.team, taskId: 'a' });
  const point = await ui.point(treeRowExpression(f.parent));
  await ui.dragOver(data, point, true);
  await ui.dragOver(data, point);
  await ui.assertNativeDragPair(point, 'filtered sidebar task to visible folder', data);
  await ui.finishDrag(data, point);
  await ui.persisted(
    (s) =>
      s.folders.some(
        (folder) =>
          folder.id === f.parent &&
          folder.children.some((child) => child.kind === 'task' && child.identity.taskId === 'a')
      ),
    'hidden sidebar task moved to visible folder'
  );
  const after = await ui.snapshot();
  const sourceFolder = after.folders.find((folder) => folder.id === f.nested)!;
  const targetFolder = after.folders.find((folder) => folder.id === f.parent)!;
  assert(
    sourceFolder.children.some(
      (child) => child.kind === 'task' && child.identity.taskId === 'missing'
    ),
    'hidden missing reference was lost'
  );
  assert(
    sourceFolder.children.some(
      (child) => child.kind === 'task' && child.identity.taskId === 'archived'
    ),
    'hidden archived reference was lost'
  );
  assert.deepEqual(
    sourceFolder.children.filter(
      (child) => !(child.kind === 'task' && child.identity.taskId === 'a')
    ),
    before.folders
      .find((folder) => folder.id === f.nested)!
      .children.filter((child) => !(child.kind === 'task' && child.identity.taskId === 'a')),
    'hidden sibling order changed during filtered move'
  );
  const lastTargetChild = targetFolder.children.at(-1);
  assert(
    lastTargetChild?.kind === 'task' && lastTargetChild.identity.taskId === 'a',
    'native drop did not append to the chosen visible folder'
  );
  await resetTreePreferences(ui);
  await restoreTaskPreferences(ui, originalPreferences);
  return {
    acceptedMime: 'application/x-agent-teams-task-v1',
    nativePair: true,
    hiddenRefsPreserved: true,
    canonicalOrderPreserved: true,
  };
}
