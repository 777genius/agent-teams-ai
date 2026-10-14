import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  click,
  pressKey,
  readJson,
  replaceJsonAtomically,
  replaceTiptapText,
  setInputValue,
  taskKeyExpression,
  until,
  visiblePageExpression,
  type Cdp,
} from './taskDetailUi.ts';

interface Team {
  teamName: string;
  taskId: string;
  taskFile: string;
  kanbanFile: string;
  project: string;
  groupChatId: string;
  groupName: string;
  secondOwner: string;
  markers: { description: string; comment: string; history: string };
}
interface Fixture {
  root: string;
  teams: Team[];
}
interface SessionSnapshot {
  commentText: string;
  commentChips: { length: number } | unknown[];
  subjectDraft: string;
  descriptionDraft: string;
  editingSubject: boolean;
  editingDescription: boolean;
}
interface SharedEvidence {
  fullDescription: string;
  fixtureCommentText: string;
  descriptionTail?: string;
  commentTail?: string;
  historyTail?: string;
  dialogDescriptionDraft: string;
  pageDescriptionDraft: string;
  commentText: string;
  commentChips: number;
  subjectDraft: string;
  descriptionDraft: string;
  ownerSurfaceId: string | null;
  writableComposerCount: number;
  dialogComposerEnabled: boolean;
  pageComposerEnabled: boolean;
  uniqueComposerIds: boolean;
}
interface DedupEvidence {
  count: number;
  active: boolean;
  composerEnabled: boolean;
}

const page = visiblePageExpression;

async function waitFile(
  path: string,
  predicate: (value: Record<string, unknown>) => boolean,
  label: string
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 18_000;
  let value: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    value = await readJson(path);
    if (predicate(value)) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label + ' ' + JSON.stringify(value));
}

async function addReadmeChip(cdp: Cdp, surface: string, key: string): Promise<void> {
  await cdp.evaluate(
    `(()=>{const t=${surface}.querySelector('textarea[id^="task-comment-input-"]');if(!t||t.disabled)throw Error('Writable composer missing');t.focus();const value='TEST_DIALOG_TAB_SHARED_V8 @README';Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,value);t.setSelectionRange(value.length,value.length);t.dispatchEvent(new Event('input',{bubbles:true}));})()`
  );
  await until(
    cdp,
    `!![...document.querySelectorAll('[role="option"]')].find(e=>e.textContent.includes('README.md'))`,
    'README suggestion for shared draft'
  );
  await click(
    cdp,
    `[...document.querySelectorAll('[role="option"]')].find(e=>e.textContent.includes('README.md'))`
  );
  await until(
    cdp,
    `window.__agentTeamsDevStore.getState().taskDetailSessionById[${key}]?.commentChips.length===1`,
    'shared rich draft file chip'
  );
}

/** Actual mounted controls write B; dev-store reads are evidence/navigation only. */
export async function runTaskEditingAndNavigationCases(
  cdp: Cdp,
  fixture: Fixture,
  record: (value: unknown) => void
): Promise<void> {
  const [teamA, teamB] = fixture.teams;
  const keyA = taskKeyExpression(teamA.teamName);
  const beforeA = await readFile(teamA.taskFile, 'utf8');
  const persistedABefore = JSON.parse(beforeA) as {
    description: string;
    comments: { id: string; text: string }[];
    historyEvents: { actor: string }[];
  };
  const beforeB = await readJson(teamB.taskFile);
  const beforeBKanban = await readJson(teamB.kanbanFile);
  const pageB = page(teamB.teamName);

  await click(cdp, `${pageB}.querySelector('h1 button')`);
  await until(
    cdp,
    `!![...${pageB}.querySelectorAll('input')].find(e=>e.value==='TEST B same ID task')`,
    'B subject editor opened'
  );
  const savedSubject = 'TEST B subject saved through UI';
  await setInputValue(
    cdp,
    `[...${pageB}.querySelectorAll('input')].find(e=>e.value==='TEST B same ID task')`,
    savedSubject
  );
  await pressKey(cdp, 'Enter', 'Enter', 13);
  await waitFile(teamB.taskFile, (task) => task.subject === savedSubject, 'B subject persisted');

  await click(
    cdp,
    `[...${pageB}.querySelectorAll('button')].find(b=>!b.textContent.trim()&&b.querySelector('svg.lucide-pencil'))`
  );
  await until(cdp, `!!${pageB}.querySelector('[contenteditable="true"]')`, 'B Tiptap editor');
  const savedDescription =
    'TEST B description saved through Tiptap and persisted without changing A';
  await replaceTiptapText(
    cdp,
    `${pageB}.querySelector('[contenteditable="true"]')`,
    savedDescription
  );
  await click(
    cdp,
    `[...${pageB}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Сохранить')`
  );
  await waitFile(
    teamB.taskFile,
    (task) => task.description === savedDescription,
    'B description persisted'
  );

  await click(cdp, `${pageB}.querySelector('[aria-label="Групповой чат"]')`);
  await until(
    cdp,
    `!![...document.querySelectorAll('[role="option"]')].find(e=>e.textContent.trim()===${JSON.stringify(teamB.groupName)})`,
    'TEST group Radix option'
  );
  await click(
    cdp,
    `[...document.querySelectorAll('[role="option"]')].find(e=>e.textContent.trim()===${JSON.stringify(teamB.groupName)})`
  );
  await waitFile(
    teamB.taskFile,
    (task) => task.groupChatId === teamB.groupChatId,
    'B group-chat association persisted'
  );

  await click(
    cdp,
    `[...${pageB}.querySelectorAll('button[role="combobox"]')].find(b=>b.className.includes('min-w-[160px]'))`
  );
  await until(
    cdp,
    `!![...document.querySelectorAll('[role="option"],[cmdk-item]')].find(e=>e.textContent.includes(${JSON.stringify(teamB.secondOwner)}))`,
    'TEST owner Radix option'
  );
  await click(
    cdp,
    `[...document.querySelectorAll('[role="option"],[cmdk-item]')].find(e=>e.textContent.includes(${JSON.stringify(teamB.secondOwner)}))`
  );
  const savedB = await waitFile(
    teamB.taskFile,
    (task) => task.owner === teamB.secondOwner,
    'B owner persisted'
  );
  const savedBKanban = await readJson(teamB.kanbanFile);
  assert.equal(await readFile(teamA.taskFile, 'utf8'), beforeA, 'B controls changed task A');
  assert.deepEqual(savedBKanban, beforeBKanban, 'B field controls changed kanban state');
  assert.equal(savedB.subject, savedSubject);
  assert.equal(savedB.description, savedDescription);
  assert.equal(savedB.groupChatId, teamB.groupChatId);
  assert.notEqual(beforeB.owner, savedB.owner);
  record({
    kind: 'actual-b-task-and-kanban-persistence',
    subjectSavedWithCurrentControl: true,
    descriptionSavedWithTiptapSave: true,
    groupChatSavedWithRadixSelect: true,
    ownerSavedWithRadixMemberSelect: true,
    taskB: savedB,
    kanbanB: savedBKanban,
    taskAUnchanged: true,
  });

  const aNavigation = (await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();const tab=s.getAllPaneTabs().find(t=>t.taskDetail&&t.teamName===${JSON.stringify(teamA.teamName)});const pane=s.paneLayout.panes.find(p=>p.tabs.some(t=>t.id===tab.id));s.focusPane(pane.id);s.openTeamTab(${JSON.stringify(teamA.teamName)});return tab.id;})()`
  )) as string;
  await until(cdp, `!${page(teamA.teamName)}`, 'A tab hidden before dialog ownership');
  await cdp.evaluate(
    `window.__agentTeamsDevStore.getState().openGlobalTaskDetail(${JSON.stringify(teamA.teamName)},'1')`
  );
  await until(
    cdp,
    `!!document.querySelector('[role="dialog"] [data-task-detail-open-tab]')`,
    'A dialog beside A tab'
  );
  await until(
    cdp,
    `(()=>{const t=document.querySelector('[role="dialog"]')?.querySelector('[id^="task-comment-input-"]');return !!t&&!t.disabled&&!t.readOnly;})()`,
    'dialog claimed the single writable owner'
  );
  await addReadmeChip(cdp, `document.querySelector('[role="dialog"]')`, keyA);
  await cdp.evaluate(
    `window.__agentTeamsDevStore.getState().setActiveTab(${JSON.stringify(aNavigation)})`
  );
  await until(cdp, `!!${page(teamA.teamName)}`, 'existing A tab visible beside owned dialog');
  const sharedBefore = (await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();const d=s.taskDetailSessionById[${keyA}];const f=s.taskDetailById[${keyA}]?.full;const dialog=document.querySelector('[role="dialog"]');const p=${page(teamA.teamName)};const composers=[dialog,p].map(root=>root?.querySelector('[id^="task-comment-input-"]'));const ids=composers.map(e=>e?.id).filter(Boolean);const writable=composers.filter(e=>e&&!e.disabled&&!e.readOnly);return {fullDescription:f?.description,fixtureCommentText:f?.comments?.find(c=>c.id==='comment-shared-124')?.text,descriptionTail:f?.description?.slice(-80),commentTail:f?.comments?.find(c=>c.id==='comment-shared-124')?.text?.slice(-160),historyTail:f?.historyEvents?.at(-1)?.actor,dialogDescriptionDraft:dialog?.querySelector('[contenteditable]')?.textContent,pageDescriptionDraft:p?.querySelector('[contenteditable]')?.textContent,commentText:d?.commentText,commentChips:d?.commentChips?.length,subjectDraft:d?.subjectDraft,descriptionDraft:d?.descriptionDraft?.slice(-80),ownerSurfaceId:d?.ownerSurfaceId,writableComposerCount:writable.length,dialogComposerEnabled:!composers[0]?.disabled&&!composers[0]?.readOnly,pageComposerEnabled:!composers[1]?.disabled&&!composers[1]?.readOnly,uniqueComposerIds:ids.length===new Set(ids).size};})()`
  )) as SharedEvidence;
  assert.equal(sharedBefore.fullDescription, persistedABefore.description);
  assert.equal(
    sharedBefore.fixtureCommentText,
    persistedABefore.comments.find((c) => c.id === 'comment-shared-124')?.text
  );
  assert(sharedBefore.fixtureCommentText.includes(teamA.markers.comment + '_124'));
  assert.equal(sharedBefore.historyTail, persistedABefore.historyEvents.at(-1)?.actor);
  assert.equal(sharedBefore.dialogDescriptionDraft, 'TESTDIRTYDESCRIPTIONHANDOFF');
  assert.equal(sharedBefore.pageDescriptionDraft, 'TESTDIRTYDESCRIPTIONHANDOFF');
  assert(sharedBefore.commentText.startsWith('TEST_DIALOG_TAB_SHARED_V8'));
  assert.equal(sharedBefore.commentChips, 1);
  assert.equal(sharedBefore.subjectDraft, 'TEST_DIRTY_SUBJECT_HANDOFF');
  assert(sharedBefore.descriptionDraft.includes('TESTDIRTYDESCRIPTIONHANDOFF'));
  assert.equal(sharedBefore.writableComposerCount, 1);
  assert.equal(sharedBefore.dialogComposerEnabled, true);
  assert.equal(sharedBefore.pageComposerEnabled, false);
  assert.equal(sharedBefore.uniqueComposerIds, true);

  const passivePane = (await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();const p=s.paneLayout.panes.find(p=>p.tabs.some(t=>t.taskDetail&&t.teamName===${JSON.stringify(teamB.teamName)}));if(!p)throw Error('B pane missing');s.focusPane(p.id);return {focusedPaneId:s.paneLayout.focusedPaneId,tabId:p.activeTabId};})()`
  )) as { focusedPaneId: string; tabId: string };
  const rawBBeforeWatcher = await readFile(teamB.taskFile, 'utf8');
  const fullBBeforeWatcher = await cdp.evaluate(
    `(()=>{const f=window.__agentTeamsDevStore.getState().taskDetailById[${taskKeyExpression(teamB.teamName)}]?.full;return {subject:f?.subject,description:f?.description,owner:f?.owner,groupChatId:f?.groupChatId};})()`
  );
  await replaceJsonAtomically(teamA.taskFile, (task) => {
    task.description = String(task.description) + 'EXTERNAL_A_SUFFIX_V8';
    const comments = task.comments as { text: string }[];
    comments.at(-1)!.text += 'EXTERNAL_A_COMMENT_SUFFIX_V8';
  });
  await until(
    cdp,
    `(()=>{const s=window.__agentTeamsDevStore.getState();const f=s.taskDetailById[${keyA}]?.full;const d=document.querySelector('[role="dialog"]');const p=${page(teamA.teamName)};return f?.description?.endsWith('EXTERNAL_A_SUFFIX_V8')&&f?.comments?.at(-1)?.text?.endsWith('EXTERNAL_A_COMMENT_SUFFIX_V8')&&d?.innerText.includes('EXTERNAL_A_COMMENT_SUFFIX_V8')&&p?.innerText.includes('EXTERNAL_A_COMMENT_SUFFIX_V8')&&d?.querySelector('[contenteditable]')?.textContent==='TESTDIRTYDESCRIPTIONHANDOFF'&&p?.querySelector('[contenteditable]')?.textContent==='TESTDIRTYDESCRIPTIONHANDOFF';})()`,
    'suffix-only watcher updated dialog and passive A page'
  );
  const passiveAfter = await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();return {focusedPaneId:s.paneLayout.focusedPaneId,tabId:s.paneLayout.panes.find(p=>p.id===s.paneLayout.focusedPaneId)?.activeTabId};})()`
  );
  assert.deepEqual(passiveAfter, passivePane, 'External A write changed pane focus');
  assert.equal(await readFile(teamB.taskFile, 'utf8'), rawBBeforeWatcher, 'A watcher changed B');
  assert.deepEqual(
    await cdp.evaluate(
      `(()=>{const f=window.__agentTeamsDevStore.getState().taskDetailById[${taskKeyExpression(teamB.teamName)}]?.full;return {subject:f?.subject,description:f?.description,owner:f?.owner,groupChatId:f?.groupChatId};})()`
    ),
    fullBBeforeWatcher,
    'A watcher changed B full state'
  );
  record({
    kind: 'dialog-tab-shared-full-tails-and-suffix-watcher',
    sharedBefore,
    passivePane,
    dialogAndPageUpdatedWithoutFocus: true,
    taskBUnchanged: true,
    noEnsureRetryOrReopen: true,
  });

  await pressKey(cdp, 'Escape', 'Escape', 27);
  await until(
    cdp,
    `!document.querySelector('[role="dialog"] [data-task-detail-open-tab]')`,
    'dialog close'
  );
  await until(
    cdp,
    `(()=>{const t=${page(teamA.teamName)}?.querySelector('textarea[id^="task-comment-input-"]');return !!t&&!t.disabled&&!t.readOnly;})()`,
    'visible A page reclaimed actual composer'
  );
  await cdp.evaluate(
    `window.__agentTeamsDevStore.getState().openGlobalTaskDetail(${JSON.stringify(teamA.teamName)},'1')`
  );
  await until(
    cdp,
    `!!document.querySelector('[role="dialog"] [data-task-detail-open-tab]')`,
    'reopened A dialog for dedup'
  );
  const tabsBeforeDedup = await cdp.evaluate(
    `window.__agentTeamsDevStore.getState().paneLayout.panes.flatMap(p=>p.tabs).filter(t=>t.taskDetail&&t.teamName===${JSON.stringify(teamA.teamName)}).length`
  );
  await click(cdp, `document.querySelector('[role="dialog"] [data-task-detail-open-tab]')`);
  await until(
    cdp,
    `!document.querySelector('[role="dialog"] [data-task-detail-open-tab]')`,
    'dedup handoff closed dialog'
  );
  const dedup = (await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();const tabs=s.paneLayout.panes.flatMap(p=>p.tabs).filter(t=>t.taskDetail&&t.teamName===${JSON.stringify(teamA.teamName)});const p=${page(teamA.teamName)};const t=p?.querySelector('textarea[id^="task-comment-input-"]');return {count:tabs.length,active:s.paneLayout.panes.some(p=>p.activeTabId===tabs[0]?.id),composerEnabled:!!t&&!t.disabled&&!t.readOnly};})()`
  )) as DedupEvidence;
  assert.equal(dedup.count, tabsBeforeDedup);
  assert.equal(dedup.count, 1);
  assert.equal(dedup.active, true);
  assert.equal(dedup.composerEnabled, true);
  record({ kind: 'existing-task-tab-open-dedup-and-dialog-close-reclaim', tabsBeforeDedup, dedup });

  const durableText = 'TEST_DURABLE_DRAFT_REOPEN_V8';
  await cdp.evaluate(
    `(()=>{const t=${page(teamA.teamName)}.querySelector('textarea[id^="task-comment-input-"]');t.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(durableText)});t.dispatchEvent(new Event('input',{bubbles:true}));})()`
  );
  await until(
    cdp,
    `window.__agentTeamsDevStore.getState().taskDetailSessionById[${keyA}]?.commentText===${JSON.stringify(durableText)}`,
    'durable comment draft typed through UI'
  );
  const draftTextKey = JSON.stringify(['task-comment', 'local', teamA.teamName, '1']);
  const draftChipsKey = JSON.stringify(['task-comment-chips', 'local', teamA.teamName, '1']);
  await until(
    cdp,
    `(async()=>{const m=await import('/services/draftStorage.ts');return await m.draftStorage.loadDraft(${JSON.stringify(draftTextKey)})===${JSON.stringify(durableText)}&&JSON.parse(await m.draftStorage.loadDraft(${JSON.stringify(draftChipsKey)})||'[]').length===1;})()`,
    'durable draft persisted before tab close'
  );

  const navigationBefore = (await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();const tab=s.paneLayout.panes.flatMap(p=>p.tabs).find(t=>t.taskDetail&&t.teamName===${JSON.stringify(teamA.teamName)});const source=s.paneLayout.panes.find(p=>p.tabs.some(t=>t.id===tab.id));return {tabId:tab.id,sourcePaneId:source.id,targetPaneId:s.paneLayout.panes.find(p=>p.id!==source.id)?.id};})()`
  )) as { tabId: string; sourcePaneId: string; targetPaneId: string };
  await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();s.focusPane(${JSON.stringify(navigationBefore.sourcePaneId)});s.openTeamTab(${JSON.stringify(teamA.teamName)});})()`
  );
  await until(cdp, `!${page(teamA.teamName)}`, 'A task hidden by ordinary-tab activation');
  const hiddenSession = (await cdp.evaluate(
    `window.__agentTeamsDevStore.getState().taskDetailSessionById[${keyA}]`
  )) as SessionSnapshot;
  assert.equal(hiddenSession.commentText, durableText);
  assert.equal(hiddenSession.commentChips.length, 1);
  assert.equal(hiddenSession.subjectDraft, 'TEST_DIRTY_SUBJECT_HANDOFF');
  assert.equal(hiddenSession.descriptionDraft, 'TESTDIRTYDESCRIPTIONHANDOFF');
  assert.equal(hiddenSession.editingSubject, true);
  assert.equal(hiddenSession.editingDescription, true);
  await cdp.evaluate(
    `window.__agentTeamsDevStore.getState().setActiveTab(${JSON.stringify(navigationBefore.tabId)})`
  );
  await until(cdp, `!!${page(teamA.teamName)}`, 'A reactivated');
  await cdp.evaluate(
    `window.__agentTeamsDevStore.getState().moveTabToPane(${JSON.stringify(navigationBefore.tabId)},${JSON.stringify(navigationBefore.sourcePaneId)},${JSON.stringify(navigationBefore.targetPaneId)},0)`
  );
  const movedSession = (await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();const pane=s.paneLayout.panes.find(p=>p.tabs.some(t=>t.id===${JSON.stringify(navigationBefore.tabId)}));return {paneId:pane?.id,session:s.taskDetailSessionById[${keyA}]};})()`
  )) as { paneId?: string; session: SessionSnapshot };
  assert.equal(movedSession.paneId, navigationBefore.targetPaneId);
  assert.equal(movedSession.session.commentText, durableText);
  assert.equal(movedSession.session.commentChips.length, 1);
  assert.equal(movedSession.session.subjectDraft, 'TEST_DIRTY_SUBJECT_HANDOFF');
  assert.equal(movedSession.session.descriptionDraft, 'TESTDIRTYDESCRIPTIONHANDOFF');
  assert.equal(movedSession.session.editingSubject, true);
  assert.equal(movedSession.session.editingDescription, true);

  await cdp.evaluate(
    `window.__agentTeamsDevStore.getState().closeTab(${JSON.stringify(navigationBefore.tabId)})`
  );
  await until(
    cdp,
    `!window.__agentTeamsDevStore.getState().paneLayout.panes.flatMap(p=>p.tabs).some(t=>t.taskDetail&&t.teamName===${JSON.stringify(teamA.teamName)})`,
    'A task tab closed'
  );
  await cdp.evaluate(
    `window.__agentTeamsDevStore.getState().openTaskDetailTab({contextId:'local',teamName:${JSON.stringify(teamA.teamName)},taskId:'1'})`
  );
  await until(cdp, `!!${page(teamA.teamName)}`, 'A reopened after close');
  await until(
    cdp,
    `(()=>{const t=${page(teamA.teamName)}?.querySelector('textarea[id^="task-comment-input-"]');return !!t&&!t.disabled&&!t.readOnly;})()`,
    'reopened task writer ready'
  );
  const restored = await cdp.evaluate(
    `(()=>{const d=window.__agentTeamsDevStore.getState().taskDetailSessionById[${keyA}];const t=${page(teamA.teamName)}?.querySelector('textarea[id^="task-comment-input-"]');return {commentText:d?.commentText,commentChips:d?.commentChips?.length,composerValue:t?.value,composerEnabled:!!t&&!t.disabled&&!t.readOnly};})()`
  );
  assert.deepEqual(restored, {
    commentText: durableText,
    commentChips: 1,
    composerValue: durableText,
    composerEnabled: true,
  });
  record({
    kind: 'pane-hide-reactivate-move-and-durable-draft-reopen',
    navigationBefore,
    hiddenSession: {
      commentText: hiddenSession.commentText,
      commentChips: hiddenSession.commentChips.length,
    },
    movedSession: {
      commentText: movedSession.session.commentText,
      commentChips: movedSession.session.commentChips.length,
    },
    restored,
  });
  const restoredInline = await cdp.evaluate(
    `(()=>{const d=window.__agentTeamsDevStore.getState().taskDetailSessionById[${keyA}];return {subject:d?.subjectDraft,description:d?.descriptionDraft,editingSubject:d?.editingSubject,editingDescription:d?.editingDescription};})()`
  );
  assert.deepEqual(restoredInline, {
    subject: 'TEST_DIRTY_SUBJECT_HANDOFF',
    description: 'TESTDIRTYDESCRIPTIONHANDOFF',
    editingSubject: true,
    editingDescription: true,
  });
  record({ kind: 'inline-drafts-survive-hide-move-close-reopen', restoredInline });
  await click(
    cdp,
    `[...${page(teamA.teamName)}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Отмена')`
  );
  await until(
    cdp,
    `!${page(teamA.teamName)}.querySelector('[contenteditable="true"]')`,
    'description draft cancelled through UI'
  );
  await click(
    cdp,
    `[...${page(teamA.teamName)}.querySelectorAll('input')].find(e=>e.value==='TEST_DIRTY_SUBJECT_HANDOFF')`
  );
  await pressKey(cdp, 'Escape', 'Escape', 27);
  await until(
    cdp,
    `!!${page(teamA.teamName)}.querySelector('h1 button')`,
    'subject draft cancelled through UI'
  );
  const persistedA = await readJson(teamA.taskFile);
  assert.equal(persistedA.subject, 'TEST A same ID task');
  assert(String(persistedA.description).endsWith('EXTERNAL_A_SUFFIX_V8'));
  assert(String(persistedA.description) !== 'TESTDIRTYDESCRIPTIONHANDOFF');
}
