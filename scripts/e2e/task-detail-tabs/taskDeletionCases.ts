import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  click,
  readJson,
  pressKey,
  taskKeyExpression,
  until,
  visiblePageExpression,
  type Cdp,
} from './taskDetailUi.ts';

interface Team {
  teamName: string;
  taskFile: string;
}
interface Fixture {
  teams: Team[];
}

async function waitTask(
  path: string,
  predicate: (task: Record<string, unknown>) => boolean,
  label: string
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 18_000;
  let task: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    task = await readJson(path);
    if (predicate(task)) return task;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label + ' ' + JSON.stringify(task));
}

/** Delete confirmation and existing Trash recovery are driven by their mounted controls. */
export async function runTaskDeletionCases(
  cdp: Cdp,
  fixture: Fixture,
  record: (value: unknown) => void
): Promise<void> {
  const [teamA, teamB] = fixture.teams;
  const keyA = taskKeyExpression(teamA.teamName);
  const keyB = taskKeyExpression(teamB.teamName);
  await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();const a=s.getAllPaneTabs().find(t=>t.taskDetail&&t.teamName===${JSON.stringify(teamA.teamName)});const b=s.getAllPaneTabs().find(t=>t.taskDetail&&t.teamName===${JSON.stringify(teamB.teamName)});if(!a||!b)throw Error('Task tabs required');const ap=s.paneLayout.panes.find(p=>p.tabs.some(t=>t.id===a.id));const bp=s.paneLayout.panes.find(p=>p.tabs.some(t=>t.id===b.id));const other=s.paneLayout.panes.find(p=>p.id!==ap.id);if(ap.id===bp.id){if(!other)throw Error('Two panes required');s.moveTabToPane(b.id,bp.id,other.id,0);}s.setActiveTab(a.id);s.setActiveTab(b.id);})()`
  );
  const pageA = visiblePageExpression(teamA.teamName);
  const pageB = visiblePageExpression(teamB.teamName);
  const durableDeleteDraft = 'TEST_B_DRAFT_PRESERVED_DELETE_V8';
  await cdp.evaluate(
    `(()=>{const t=${pageB}.querySelector('textarea[id^="task-comment-input-"]');if(!t||t.disabled)throw Error('B composer not writable before delete');t.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(durableDeleteDraft)});t.dispatchEvent(new Event('input',{bubbles:true}));})()`
  );
  await until(
    cdp,
    `window.__agentTeamsDevStore.getState().taskDetailSessionById[${keyB}]?.commentText===${JSON.stringify(durableDeleteDraft)}`,
    'B delete-surviving draft typed through UI'
  );

  const beforeCancelA = await readFile(teamA.taskFile, 'utf8');
  await click(
    cdp,
    `[...${pageA}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Удалить')`
  );
  await until(
    cdp,
    `!!document.querySelector('[role="dialog"][aria-label="Удалить задачу"]')`,
    'A delete confirmation opened'
  );
  await click(
    cdp,
    `[...document.querySelector('[role="dialog"][aria-label="Удалить задачу"]').querySelectorAll('button')].find(b=>b.textContent.trim()==='Отмена')`
  );
  await until(
    cdp,
    `!document.querySelector('[role="dialog"][aria-label="Удалить задачу"]')`,
    'A delete confirmation cancelled'
  );
  assert.equal(
    await readFile(teamA.taskFile, 'utf8'),
    beforeCancelA,
    'Cancelled delete changed A JSON'
  );
  const phaseA = await cdp.evaluate(
    `window.__agentTeamsDevStore.getState().taskDetailById[${keyA}]?.phase`
  );
  assert.equal(phaseA, 'ready');
  record({ kind: 'cancel-delete-a-persisted-json-unchanged', taskAUnchanged: true, phaseA });

  const beforeDeleteB = await readFile(teamB.taskFile, 'utf8');
  await click(
    cdp,
    `[...${pageB}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Удалить')`
  );
  await until(
    cdp,
    `!!document.querySelector('[role="dialog"][aria-label="Удалить задачу"]')`,
    'B delete confirmation opened'
  );
  await click(
    cdp,
    `document.querySelector('[role="dialog"][aria-label="Удалить задачу"] [data-confirm-btn]')`
  );
  const deletedB = await waitTask(
    teamB.taskFile,
    (task) => task.status === 'deleted' || typeof task.deletedAt === 'string',
    'confirmed B deletion persisted'
  );
  assert.notEqual(await readFile(teamB.taskFile, 'utf8'), beforeDeleteB);
  await until(
    cdp,
    `window.__agentTeamsDevStore.getState().taskDetailById[${keyB}]?.phase==='deleted'`,
    'B accepted deleted full state'
  );
  await cdp.evaluate(
    `window.__agentTeamsDevStore.getState().openGlobalTaskDetail(${JSON.stringify(teamB.teamName)},'1')`
  );
  await until(
    cdp,
    `(()=>{const d=document.querySelector('[role="dialog"]');const p=${pageB};return d?.innerText.includes('Задача удалена')&&p?.innerText.includes('Задача удалена');})()`,
    'deleted banner on B dialog and page'
  );
  const deletedSurfaces = await cdp.evaluate(
    `(()=>{const d=document.querySelector('[role="dialog"]');const p=${pageB};const composer=(root)=>root?.querySelector('textarea[id^="task-comment-input-"]');const subject=(root)=>root?.querySelector('h1 button,h2 button');const del=(root)=>[...root.querySelectorAll('button')].find(b=>b.textContent.trim()==='Удалить');return {draft:window.__agentTeamsDevStore.getState().taskDetailSessionById[${keyB}]?.commentText,pageComposerDisabled:composer(p)?.disabled,dialogComposerDisabled:composer(d)?.disabled,pageSubjectDisabled:subject(p)?.disabled,dialogSubjectDisabled:subject(d)?.disabled,pageDeleteDisabled:del(p)?.disabled,dialogDeleteDisabled:del(d)?.disabled??null};})()`
  );
  assert.deepEqual(deletedSurfaces, {
    draft: durableDeleteDraft,
    pageComposerDisabled: true,
    dialogComposerDisabled: true,
    pageSubjectDisabled: true,
    dialogSubjectDisabled: true,
    pageDeleteDisabled: true,
    dialogDeleteDisabled: null,
  });
  record({
    kind: 'confirm-delete-b-persisted-readonly-surfaces-and-draft',
    deletedB,
    deletedSurfaces,
  });

  await cdp.evaluate(`window.__agentTeamsDevStore.getState().closeGlobalTaskDetail()`);
  await cdp.evaluate(
    `window.__agentTeamsDevStore.getState().openTeamTab(${JSON.stringify(teamB.teamName)})`
  );
  await until(
    cdp,
    `window.__agentTeamsDevStore.getState().deletedTasks.some(t=>t.id==='1')`,
    'existing Trash catalog loaded deleted B'
  );
  const trashButton = `[...document.querySelectorAll('button')].find(b=>{if(!b.querySelector('svg.lucide-trash-2')||b.textContent.trim()!=='1')return false;b.scrollIntoView({block:'center',behavior:'instant'});const r=b.getBoundingClientRect();return r.width>0&&r.height>0&&b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})`;
  await until(cdp, `!!(${trashButton})`, 'visible B Trash action after dialog exit');
  await click(cdp, trashButton);
  await until(
    cdp,
    `(()=>{const d=[...document.querySelectorAll('[role="dialog"]')].find(e=>e.innerText.includes('Корзина'));return !!d&&!!d.querySelector('button[aria-label="Восстановить задачу"]');})()`,
    'existing Trash UI opened'
  );
  await click(cdp, `document.querySelector('button[aria-label="Восстановить задачу"]')`);
  const restoredB = await waitTask(
    teamB.taskFile,
    (task) => task.status !== 'deleted' && task.deletedAt === undefined,
    'Trash restore persisted live B'
  );
  await until(
    cdp,
    `window.__agentTeamsDevStore.getState().taskDetailById[${keyB}]?.phase==='ready'`,
    'restored B accepted full state'
  );
  await pressKey(cdp, 'Escape', 'Escape', 27);
  await until(
    cdp,
    `![...document.querySelectorAll('[role="dialog"]')].some(d=>d.innerText.includes('Корзина'))`,
    'Trash dialog closed after restore'
  );
  await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();const tab=s.getAllPaneTabs().find(t=>t.taskDetail&&t.teamName===${JSON.stringify(teamB.teamName)});s.setActiveTab(tab.id);})()`
  );
  await until(cdp, `!!${pageB}`, 'restored B task page visible');
  const liveRecovery = await cdp.evaluate(
    `(()=>{const p=${pageB};const t=p.querySelector('textarea[id^="task-comment-input-"]');return {phase:window.__agentTeamsDevStore.getState().taskDetailById[${keyB}]?.phase,draft:window.__agentTeamsDevStore.getState().taskDetailSessionById[${keyB}]?.commentText,composerValue:t?.value,composerEnabled:!!t&&!t.disabled};})()`
  );
  assert.deepEqual(liveRecovery, {
    phase: 'ready',
    draft: durableDeleteDraft,
    composerValue: durableDeleteDraft,
    composerEnabled: true,
  });
  record({
    kind: 'existing-trash-ui-live-recovery',
    restoredB,
    liveRecovery,
    noInventedPageRestoreButton: true,
  });
}
