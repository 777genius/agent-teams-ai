import assert from 'node:assert/strict';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  markers: { description: string };
}
interface Fixture {
  teams: Team[];
  env: Record<string, string>;
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

async function snapshotTaskAndAssets(
  taskFile: string,
  assetDir: string
): Promise<{ task: string; assets: [string, string][] }> {
  const task = await readFile(taskFile, 'utf8');
  const names = await readdir(assetDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  const assets = await Promise.all(
    names.sort().map(async (name) => {
      const bytes = await readFile(join(assetDir, name));
      return [name, bytes.toString('base64')] as [string, string];
    })
  );
  return { task, assets };
}

async function writeTeamDeletedMarker(
  configFile: string,
  deletedAt: string | undefined
): Promise<void> {
  const config = JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>;
  const next = { ...config };
  if (deletedAt) next.deletedAt = deletedAt;
  else delete next.deletedAt;
  const temporary = configFile + '.task-tabs-TEST.tmp';
  await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  await rename(temporary, configFile);
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
  const expandAttachments = `(()=>{const p=${pageB};return [...p.querySelectorAll('span')].find(e=>e.textContent?.trim()==='Вложения')?.closest('section')?.querySelector('button[aria-label="Expand section"]');})()`;
  if (await cdp.evaluate(`Boolean(${expandAttachments})`)) await click(cdp, expandAttachments);
  await until(
    cdp,
    `(()=>{const p=${pageB};return [...p.querySelectorAll('button')].some(b=>b.textContent.trim()==='Прикрепить изображение');})()`,
    'B attachment section mounted through its UI header'
  );
  const assetDirB = join(
    fixture.env.AGENT_TEAMS_ELECTRON_USER_DATA_DIR,
    'data',
    'task-attachments',
    teamB.teamName,
    '1'
  );
  await cdp.evaluate(
    `(()=>{const p=${pageB};const button=[...p.querySelectorAll('button')].find(b=>b.textContent.trim()==='Прикрепить изображение');const input=button?.previousElementSibling;if(!(input instanceof HTMLInputElement)||input.type!=='file')throw Error('Mounted task upload input missing');const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0));const dt=new DataTransfer();dt.items.add(new File([bytes],'TEST-before-delete.png',{type:'image/png'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`
  );
  await waitTask(
    teamB.taskFile,
    (task) => Array.isArray(task.attachments) && task.attachments.length === 1,
    'B live task attachment persisted through mounted FileReader route'
  );
  assert.equal(
    (await readdir(assetDirB)).filter((name) => name.endsWith('--TEST-before-delete.png')).length,
    1
  );

  await until(
    cdp,
    `(()=>{const image=${pageB}?.querySelector('img[alt="TEST-before-delete.png"]');return image instanceof HTMLImageElement&&image.complete&&image.naturalWidth===1;})()`,
    'B task attachment preview decoded before deletion'
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
  const beforeAttachmentMutation = await snapshotTaskAndAssets(teamB.taskFile, assetDirB);
  const deletedAttachmentRoutes = await cdp.evaluate(
    `(()=>{const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';const file=(name)=>new File([Uint8Array.from(atob(png),c=>c.charCodeAt(0))],name,{type:'image/png'});const transfer=(name)=>{const dt=new DataTransfer();dt.items.add(file(name));return dt;};const roots=[${pageB},document.querySelector('[role="dialog"]')];const result=[];for(const root of roots){if(!root)throw Error('Deleted attachment surface missing');const img=root.querySelector('img[alt="TEST-before-delete.png"]');if(!(img instanceof HTMLImageElement)||!img.complete||img.naturalWidth!==1)throw Error('Deleted task preview/download attachment missing');const thumb=img.closest('div.group');const container=thumb?.parentElement?.parentElement;if(!container)throw Error('Task attachment container missing');const input=container.querySelector('input[type=file]');if(!(input instanceof HTMLInputElement))throw Error('Mounted upload input missing');const deleteButtons=[...container.querySelectorAll('button')].filter(b=>b.querySelector('.lucide-trash-2'));const deleteRoutes=deleteButtons.filter(b=>!b.disabled).length;for(const button of deleteButtons){button.disabled=false;button.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));button.disabled=true;}input.disabled=false;input.files=transfer('TEST-after-file-input.png').files;input.dispatchEvent(new Event('change',{bubbles:true}));input.disabled=true;container.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer('TEST-after-paste.png')}));container.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer('TEST-after-drop.png')}));result.push({previewRetained:true,deleteRoutes,uploadInputMounted:true});}return result;})()`
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  const afterAttachmentMutation = await snapshotTaskAndAssets(teamB.taskFile, assetDirB);
  assert.deepEqual(
    afterAttachmentMutation,
    beforeAttachmentMutation,
    'Deleted B upload/paste/drop/delete routes changed task or asset state'
  );
  assert.deepEqual(deletedAttachmentRoutes, [
    { previewRetained: true, deleteRoutes: 0, uploadInputMounted: true },
    { previewRetained: true, deleteRoutes: 0, uploadInputMounted: true },
  ]);
  record({
    kind: 'confirmed-delete-b-attachment-mutations-rejected',
    routes: deletedAttachmentRoutes,
    taskAndAssetStateUnchanged: true,
    mountedUploadInputAndFileReaderGuarded: true,
    previewRetained: true,
  });

  // A forced click on a React-disabled button can bubble to its preview parent.
  // Close any resulting lightbox through its real control before navigating.
  for (let i = 0; i < 2; i++) {
    const count = Number(await cdp.evaluate(`document.querySelectorAll('.yarl__root').length`));
    if (count === 0) break;
    await click(
      cdp,
      `[...document.querySelectorAll('.yarl__root button.yarl__button[aria-label="Close"]')].at(-1)`
    );
    await until(
      cdp,
      `document.querySelectorAll('.yarl__root').length<${count}`,
      'attachment preview closed'
    );
  }
  assert.equal(await cdp.evaluate(`document.querySelectorAll('.yarl__root').length`), 0);

  await cdp.evaluate(`window.__agentTeamsDevStore.getState().closeGlobalTaskDetail()`);
  await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();s.openTeamTab(${JSON.stringify(teamB.teamName)});const tab=s.getAllPaneTabs().find(t=>t.type==='team'&&!t.taskDetail&&t.teamName===${JSON.stringify(teamB.teamName)});const pane=s.paneLayout.panes.find(p=>p.tabs.some(t=>t.id===tab.id));s.focusPane(pane.id);s.resizePanes(pane.id,0.8);})()`
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

  const configB = join(
    fixture.env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT,
    'teams',
    teamB.teamName,
    'config.json'
  );
  const beforeTeamDelete = await snapshotTaskAndAssets(teamB.taskFile, assetDirB);
  const teamDeletedAt = new Date().toISOString();
  await writeTeamDeletedMarker(configB, teamDeletedAt);
  await until(
    cdp,
    `window.__agentTeamsDevStore.getState().taskDetailById[${keyB}]?.phase==='unavailable'`,
    'whole-team config deletion reached the open task tab through the real watcher'
  );
  await cdp.evaluate(
    `(async()=>{const s=window.__agentTeamsDevStore.getState();await s.ensureTaskDetail({contextId:'local',teamName:${JSON.stringify(teamB.teamName)},taskId:'1'});await s.ensureTaskDetail({contextId:'local',teamName:${JSON.stringify(teamB.teamName)},taskId:'1'});})()`
  );
  const deletedTeamState = await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();const p=${pageB};const t=p?.querySelector('textarea[id^="task-comment-input-"]');return {phase:s.taskDetailById[${keyB}]?.phase,draft:s.taskDetailSessionById[${keyB}]?.commentText,composerMounted:!!t,composerEnabled:!!t&&!t.disabled,full:s.taskDetailById[${keyB}]?.full};})()`
  );
  assert.deepEqual(
    deletedTeamState,
    {
      phase: 'unavailable',
      draft: durableDeleteDraft,
      composerMounted: false,
      composerEnabled: false,
      full: null,
    },
    'Whole-team deletion left retained task data unavailable and readonly'
  );
  assert.deepEqual(
    await snapshotTaskAndAssets(teamB.taskFile, assetDirB),
    beforeTeamDelete,
    'Whole-team deletion changed retained task or asset bytes'
  );
  record({
    kind: 'whole-team-delete-task-detail-readonly',
    teamDeletedAt,
    retainedTaskAndAssets: true,
    draftPreserved: true,
    successorFullReadsStayUnavailable: true,
  });

  await writeTeamDeletedMarker(configB, undefined);
  await cdp.evaluate(
    `(async()=>{await window.__agentTeamsDevStore.getState().ensureTaskDetail({contextId:'local',teamName:${JSON.stringify(teamB.teamName)},taskId:'1'});})()`
  );
  await until(
    cdp,
    `window.__agentTeamsDevStore.getState().taskDetailById[${keyB}]?.phase==='ready'`,
    'accepted restored team snapshot reauthorized the full task read'
  );
  const restoredTeamState = (await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();const p=${pageB};const t=p.querySelector('textarea[id^="task-comment-input-"]');return {phase:s.taskDetailById[${keyB}]?.phase,draft:s.taskDetailSessionById[${keyB}]?.commentText,composerValue:t?.value,composerEnabled:!!t&&!t.disabled,description:s.taskDetailById[${keyB}]?.full?.description};})()`
  )) as {
    phase: string;
    draft: string;
    composerValue: string;
    composerEnabled: boolean;
    description?: string;
  };
  assert.deepEqual(
    {
      ...restoredTeamState,
      description: restoredTeamState.description?.includes(teamB.markers.description),
    },
    {
      phase: 'ready',
      draft: durableDeleteDraft,
      composerValue: durableDeleteDraft,
      composerEnabled: true,
      description: true,
    },
    'Accepted team restoration recovered the authoritative full task'
  );
  assert.deepEqual(
    await snapshotTaskAndAssets(teamB.taskFile, assetDirB),
    beforeTeamDelete,
    'Whole-team deletion/restoration changed retained task or asset bytes'
  );
  record({
    kind: 'whole-team-restore-full-read-recovery',
    acceptedFullDescriptionMarker: true,
    draftPreserved: true,
    composerReauthorized: true,
  });
}
