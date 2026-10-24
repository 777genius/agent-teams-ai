import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

interface Cdp {
  evaluate(expression: string): Promise<unknown>;
}
interface Fixture {
  root: string;
  teams: { teamName: string; taskFile: string }[];
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(cdp: Cdp, expression: string, label: string) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}

/** Real renderer inputs and IPC; store access is navigation/evidence only. */
export async function runSessionAndPaneCases(
  cdp: Cdp,
  fixture: Fixture,
  record: (value: unknown) => void
): Promise<void> {
  const [teamA, teamB] = fixture.teams;
  const identityA = { contextId: 'local', teamName: teamA.teamName, taskId: '1' };
  const keyA = JSON.stringify(['local', teamA.teamName, '1']);
  const keyB = JSON.stringify(['local', teamB.teamName, '1']);
  const originalA = JSON.parse(await readFile(teamA.taskFile, 'utf8')) as {
    comments: { text: string }[];
  };
  const originalB = await readFile(teamB.taskFile, 'utf8');
  await cdp.evaluate(
    `(()=>{const page=[...document.querySelectorAll('[data-task-detail-page]')].find(p=>p.getBoundingClientRect().width>0&&p.querySelector('textarea')?.value.startsWith('TEST_HANDOFF_DRAFT_V7'));const button=page?.querySelector('button.message-composer-send-button');if(!button||button.disabled)throw Error('Actual send button unavailable');button.click();button.click();})()`
  );
  await until(
    cdp,
    `(()=>{const d=window.__agentTeamsDevStore.getState().taskDetailSessionById[${JSON.stringify(keyA)}];return d&&!d.submitPending&&d.commentText==='';})()`,
    'actual comment accepted and composer cleared'
  );
  const savedA = JSON.parse(await readFile(teamA.taskFile, 'utf8')) as {
    comments: { text: string; attachments?: unknown[] }[];
  };
  assert.equal(savedA.comments.length, originalA.comments.length + 1);
  assert.equal(
    savedA.comments.filter((comment) => comment.text.includes('TEST_HANDOFF_DRAFT_V7')).length,
    1
  );
  assert.equal(savedA.comments.at(-1)?.attachments?.length, 1);
  assert(savedA.comments.at(-1)?.text.includes('README.md'));
  assert(savedA.comments.at(-1)?.text.includes('COMMENT_TAIL_A'));
  assert.equal(await readFile(teamB.taskFile, 'utf8'), originalB, 'Submit changed the other team');
  await until(
    cdp,
    `(()=>{const page=[...document.querySelectorAll('[data-task-detail-page]')].find(p=>p.getBoundingClientRect().width>0);const input=page?.querySelector('textarea[id^="task-comment-input-"]');return !!input&&!input.disabled&&!input.readOnly;})()`,
    'composer writable again after the accepted comment refresh'
  );
  await cdp.evaluate(
    `(()=>{const page=[...document.querySelectorAll('[data-task-detail-page]')].find(p=>p.getBoundingClientRect().width>0);const t=page.querySelector('textarea[id^="task-comment-input-"]');if(!t||t.disabled)throw Error('Actual composer unavailable after submit');t.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'TEST_NEWER_DRAFT_AFTER_SUBMIT');t.dispatchEvent(new Event('input',{bubbles:true}));})()`
  );
  await until(
    cdp,
    `window.__agentTeamsDevStore.getState().taskDetailSessionById[${JSON.stringify(keyA)}]?.commentText==='TEST_NEWER_DRAFT_AFTER_SUBMIT'`,
    'new typed draft after accepted submit'
  );
  record({
    kind: 'one-real-comment-with-file-chip-reply-and-attachment',
    physicalCommentCount: savedA.comments.length,
    sourceTask: teamA.teamName,
    otherTeamFileUnchanged: true,
    newerDraftTypedThroughUI: true,
    asyncReplyRaces: 'covered by controlled critical tests',
  });

  // Read a visible comment in A while B is hidden, despite identical comment IDs.
  const targetId = (await cdp.evaluate(
    `(async()=>{const storage=await import('/services/commentReadStorage.ts');const readB=storage.getReadCommentIds({contextId:'local',teamName:${JSON.stringify(teamB.teamName)},taskId:'1'});const page=[...document.querySelectorAll('[data-task-detail-page]')].find(p=>p.getBoundingClientRect().width>0);const item=[...page.querySelectorAll('[data-task-comment-id]')].find(e=>e.dataset.taskCommentId?.startsWith('comment-shared-')&&!readB.has(e.dataset.taskCommentId));if(!item)throw Error('No unseen shared-ID comment for hidden-team proof');item.scrollIntoView({block:'center'});return item.dataset.taskCommentId;})()`
  )) as string;
  await until(
    cdp,
    `(async()=>{const storage=await import('/services/commentReadStorage.ts');return storage.getReadCommentIds(${JSON.stringify(identityA)}).has(${JSON.stringify(targetId)});})()`,
    'visible A comment read marker'
  );
  assert.equal(
    await cdp.evaluate(
      `(async()=>{const storage=await import('/services/commentReadStorage.ts');return storage.getReadCommentIds({contextId:'local',teamName:${JSON.stringify(teamB.teamName)},taskId:'1'}).has(${JSON.stringify(targetId)});})()`
    ),
    false
  );
  record({
    kind: 'viewport-read-isolated-across-same-comment-ids',
    targetId,
    readInA: true,
    readInHiddenB: false,
  });

  await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();const pane=s.paneLayout.panes.find(p=>p.tabs.some(t=>t.taskDetail&&t.teamName===${JSON.stringify(teamB.teamName)}));const tab=pane?.tabs.find(t=>t.taskDetail&&t.teamName===${JSON.stringify(teamB.teamName)});if(!tab)throw Error('Task B tab missing');s.splitPane(pane.id,tab.id,'right');})()`
  );
  await until(
    cdp,
    `(()=>{const s=window.__agentTeamsDevStore.getState();const pages=[...document.querySelectorAll('[data-task-detail-page]')].filter(p=>p.getBoundingClientRect().width>0&&p.getBoundingClientRect().height>0);const entries=Object.values(s.taskDetailResourcesById).filter(e=>e.kind==='changes'&&[${JSON.stringify(teamA.teamName)},${JSON.stringify(teamB.teamName)}].includes(e.identity.teamName));return pages.length===2&&entries.length>=2&&entries.every(e=>e.loaded&&!e.loading&&!e.refreshPending);})()`,
    'two independent active task panes refresh resources regardless of focus'
  );
  const panes = await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();return {focusedPaneId:s.paneLayout.focusedPaneId,panes:s.paneLayout.panes.map(p=>({id:p.id,activeTabId:p.activeTabId,task:p.tabs.find(t=>t.id===p.activeTabId)?.taskDetail})),draftA:s.taskDetailSessionById[${JSON.stringify(keyA)}]?.commentText,draftB:s.taskDetailSessionById[${JSON.stringify(keyB)}]?.commentText};})()`
  );
  record({ kind: 'two-active-task-panes-with-one-focused', panes });
}
