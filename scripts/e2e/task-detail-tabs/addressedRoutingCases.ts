import assert from 'node:assert/strict';
import { join } from 'node:path';

import { click, until, visiblePageExpression, type Cdp } from './taskDetailUi.ts';

interface Team {
  teamName: string;
  project: string;
}
interface Fixture {
  teams: Team[];
}

/** Addressed file navigation stays in the originating team/project; refusal retains Retry. */
export async function runAddressedRoutingCases(
  cdp: Cdp,
  fixture: Fixture,
  record: (value: unknown) => void
): Promise<void> {
  const [teamA, teamB] = fixture.teams;
  const pageA = visiblePageExpression(teamA.teamName);
  await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();const tabs=s.getAllPaneTabs();const task=tabs.find(t=>t.taskDetail&&t.teamName===${JSON.stringify(teamA.teamName)});const pane=s.paneLayout.panes.find(p=>p.tabs.some(t=>t.id===task.id));const other=s.paneLayout.panes.find(p=>p.id!==pane.id);if(!other)throw Error('Two panes required');s.focusPane(other.id);s.openTeamTab(${JSON.stringify(teamB.teamName)});const ordinary=s.getAllPaneTabs().find(t=>t.type==='team'&&!t.taskDetail&&t.teamName===${JSON.stringify(teamA.teamName)});const source=ordinary&&s.paneLayout.panes.find(p=>p.tabs.some(t=>t.id===ordinary.id));if(ordinary&&source&&source.id!==pane.id)s.moveTabToPane(ordinary.id,source.id,pane.id,0);s.setActiveTab(task.id);s.focusPane(other.id);})()`
  );
  await until(cdp, `!!${pageA}`, 'A visible beside B ordinary host');
  await until(
    cdp,
    `!![...${pageA}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Показать больше')`,
    'description expansion control'
  );
  await click(
    cdp,
    `[...${pageA}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Показать больше')`
  );

  await click(cdp, `${pageA}.querySelector('a[href="README.md"]')`);
  const readme = join(teamA.project, 'README.md');
  await until(
    cdp,
    `(()=>{const s=window.__agentTeamsDevStore.getState();return s.editorProjectPath===${JSON.stringify(teamA.project)}&&s.editorActiveTabId===${JSON.stringify(readme)}&&s.editorFileTree!==null&&!s.editorFileTreeLoading&&s.pendingTaskDetailEditorRequest===null&&s.editorPendingRevealFile===null;})()`,
    'addressed editor request consumed by A project'
  );
  await until(
    cdp,
    `!!document.querySelector('[role="dialog"][aria-label="Редактор проекта"] [data-editor-file=${JSON.stringify(readme)}]')`,
    'actual project editor overlay opened requested file'
  );
  const editorEvidence = await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();return {projectPath:s.editorProjectPath,activeFile:s.editorActiveTabId,fileTreeReady:s.editorFileTree!==null&&!s.editorFileTreeLoading,pending:s.pendingTaskDetailEditorRequest,legacyPending:s.editorPendingRevealFile,overlayFile:document.querySelector('[data-editor-file]')?.getAttribute('data-editor-file'),bProjectLoaded:s.editorProjectPath===${JSON.stringify(teamB.project)}};})()`
  );
  assert.deepEqual(editorEvidence, {
    projectPath: teamA.project,
    activeFile: readme,
    fileTreeReady: true,
    pending: null,
    legacyPending: null,
    overlayFile: readme,
    bProjectLoaded: false,
  });
  await click(
    cdp,
    `document.querySelector('[role="dialog"][aria-label="Редактор проекта"] button[aria-label="Закрыть редактор"]')`
  );
  await until(
    cdp,
    `!document.querySelector('[role="dialog"][aria-label="Редактор проекта"]')`,
    'project editor overlay closed'
  );
  record({
    kind: 'addressed-real-file-editor-origin-routing',
    editorEvidence,
    wrongVisiblePaneIgnored: true,
  });

  const reviewCard = `[...document.querySelectorAll('[data-task-id="1"]')].find(e=>e.getBoundingClientRect().width>0&&e.innerText.includes('TEST A same ID task'))`;
  await until(cdp, `!!(${reviewCard})`, 'actual A task card');
  const hoverPoint = (await cdp.evaluate(
    `(()=>{const e=${reviewCard};e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`
  )) as { x: number; y: number };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hoverPoint });
  const reviewButton = `(${reviewCard})?.querySelector('button:has(svg.lucide-file-code)')||[...document.querySelectorAll('[data-kanban-task-toolbar="true"] button:has(svg.lucide-file-code)')].find(e=>e.getBoundingClientRect().width>0)`;
  await until(cdp, `!!(${reviewButton})`, 'actual A task review action');
  await click(cdp, reviewButton);
  await until(
    cdp,
    `(()=>{const s=window.__agentTeamsDevStore.getState();return !!document.querySelector('button[aria-label="Close Changes"]')&&!s.changeSetLoading&&s.activeChangeSet?.scope?.taskId==='1';})()`,
    'real task review loaded'
  );
  const reviewEvidence = (await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();return {taskId:s.activeChangeSet?.scope?.taskId,selectedTeamName:s.selectedTeamName,loading:s.changeSetLoading,fileCount:s.activeChangeSet?.files?.length,warnings:s.activeChangeSet?.warnings,title:[...document.querySelectorAll('h2')].find(e=>e.textContent.includes('Changes for task'))?.textContent};})()`
  )) as {
    taskId: string;
    selectedTeamName: string;
    loading: boolean;
    fileCount: number;
    warnings?: string[];
    title?: string;
  };
  assert.equal(reviewEvidence.taskId, '1');
  assert.equal(reviewEvidence.selectedTeamName, teamA.teamName);
  assert.equal(reviewEvidence.loading, false);
  assert.equal(reviewEvidence.fileCount, 0);
  assert(
    reviewEvidence.warnings?.some((warning) => warning.includes('TEST review routing fixture'))
  );
  assert(reviewEvidence.title?.includes('Changes for task'));
  await click(cdp, `document.querySelector('button[aria-label="Close Changes"]')`);
  await until(
    cdp,
    `!document.querySelector('button[aria-label="Close Changes"]')`,
    'actual task review closed'
  );
  record({
    kind: 'real-task-review-ui-ready',
    reviewEvidence,
    entry: 'mounted task card action',
    refusalAndStaleNonce: 'controlled critical integration tests',
  });
}
