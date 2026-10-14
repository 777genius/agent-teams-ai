/** Fresh Linux desktop/CDP task-tab regression, with all non-version runtime calls denied.
 * TASK_TABS_E2E_SCRATCH=/srv/workers/<owned-scratch> node scripts/e2e/task-detail-tabs-desktop.ts <exact-sha>
 * Supply an isolated DISPLAY; TASK_TABS_E2E_PNPM optionally points to a pinned pnpm JS entrypoint.
 * The receipt lists proven cases. Full task-tab E2E remains false until all planned cases exist.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { prepareTaskTabsFixture } from './task-detail-tabs/fixture.ts';
import { runSessionAndPaneCases } from './task-detail-tabs/sessionCases.ts';
import { prepareRichTaskDraft } from './task-detail-tabs/richDraftInput.ts';

interface Team {
  teamName: string;
  taskId: string;
  taskFile: string;
  project: string;
  markers: {
    description: string;
    prompt: string;
    source: string;
    comment: string;
    history: string;
  };
}
interface Fixture {
  root: string;
  env: Record<string, string>;
  teams: Team[];
  preparedAgainstSourceCommit: string;
}
interface Cdp {
  evaluate(expression: string): Promise<unknown>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(method: string, listener: (event: unknown) => void): void;
  screenshot(path: string): Promise<void>;
  close(): Promise<void>;
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = process.argv[2];
assert(sha && /^[a-f0-9]{40}$/.test(sha), 'Supply the exact integrated source SHA');
assert.equal(process.platform, 'linux', 'Hosted Linux desktop harness');
assert(process.env.DISPLAY, 'Supply an isolated Xvfb DISPLAY');
assert.equal(
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  sha
);
assert.equal(
  execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(),
  '',
  'Commit the tested harness and source first'
);
const scratchPath = process.env.TASK_TABS_E2E_SCRATCH ?? '/srv/workers/task-tabs-e2e-scratch';
await mkdir(scratchPath, { recursive: true, mode: 0o700 });
const scratch = await realpath(scratchPath);
assert(scratch.startsWith('/srv/workers/'));
const runtime = JSON.parse(await readFile(join(repo, 'runtime.lock.json'), 'utf8')) as {
  version: string;
};
const fixture: Fixture = prepareTaskTabsFixture(scratch, sha, runtime.version);
const root = fixture.root;
console.log(JSON.stringify({ fixture: root, testedSourceCommit: sha, fullTaskTabsE2E: false }));
const transport = (await import(
  pathToFileURL(join(repo, 'scripts/e2e/comment-notification/cdp.mjs')).href
)) as { CdpClient: { connect(url: string): Promise<Cdp> } };
const shutdown = (await import(
  pathToFileURL(join(repo, 'scripts/e2e/task-folders/shutdown.ts')).href
)) as {
  stopOwnedGroup(group: number): Promise<void>;
  gracefulClose(cdp: Cdp, port: number, group: number): Promise<unknown>;
};
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => Promise<unknown>, label: string, ms = 180000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(150);
  }
  throw new Error('Timed out: ' + label);
}
const rendererPort = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const a = server.address();
    assert(a && typeof a !== 'string');
    server.close(() => resolve(a.port));
  });
});
const config = join(root, 'electron.watcher-v7.config.mts');
await writeFile(
  config,
  `import config from ${JSON.stringify(join(repo, 'electron.vite.config.ts'))};\nexport default {...config, renderer:{...config.renderer,server:{...config.renderer?.server,port:${rendererPort},strictPort:true}}};\n`,
  { flag: 'wx', mode: 0o600 }
);

const env: Record<string, string> = {
  ...fixture.env,
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  DISPLAY: process.env.DISPLAY,
  NODE_ENV: 'development',
  NO_SANDBOX: '1',
};
if (process.env.XAUTHORITY) env.XAUTHORITY = process.env.XAUTHORITY;
let app: ChildProcess | undefined;
let cdp: Cdp | undefined;
let port: number | undefined;
let logs = '';
let failure: string | undefined;
let closeEvidence: unknown;
const faults: unknown[] = [];
const reads: unknown[] = [];
const diagnostics: unknown[] = [];
let passed = false;
let launchError: Error | undefined;
const receiptPath = join(root, 'electron-watcher-v7-' + sha.slice(0, 7) + '.json');
async function receipt() {
  await writeFile(
    receiptPath,
    JSON.stringify(
      {
        kind: 'task-detail-tabs-desktop-v1',
        testedSourceCommit: sha,
        fullTaskTabsE2E: false,
        passed,
        root,
        rendererPort,
        cdpPort: port,
        ownedProcessGroup: app?.pid,
        display: env.DISPLAY,
        reads,
        diagnostics,
        faults,
        closeEvidence,
        failure,
        runtimeAudit: await readFile(join(root, 'runtime-audit.ndjson'), 'utf8'),
        scriptSha256: createHash('sha256')
          .update(await readFile(new URL(import.meta.url)))
          .digest('hex'),
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );
}
try {
  const pnpm = process.env.TASK_TABS_E2E_PNPM;
  app = spawn(
    pnpm ? process.execPath : 'pnpm',
    [
      ...(pnpm ? [pnpm] : []),
      '--config.verify-deps-before-run=false',
      'dev:mcp',
      '--',
      '--config',
      config,
    ],
    { cwd: repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  app.once('error', (error) => {
    launchError = error;
  });
  for (const stream of [app.stdout, app.stderr])
    stream?.on('data', (chunk: Buffer) => {
      logs += chunk.toString();
    });
  await until(async () => {
    if (launchError) throw launchError;
    if (app?.exitCode !== null) throw new Error('Owned launcher exited ' + app?.exitCode);
    const match = logs.match(
      /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//
    );
    if (!match) return false;
    port = Number(match[1]);
    const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())) as {
      type: string;
      url: string;
      webSocketDebuggerUrl: string;
    }[];
    const page = targets.find(
      (t) =>
        t.type === 'page' &&
        /^http:\/\/(?:localhost|127\.0\.0\.1):/.test(t.url) &&
        new URL(t.url).port === String(rendererPort)
    );
    if (!page) return false;
    cdp = await transport.CdpClient.connect(page.webSocketDebuggerUrl);
    return true;
  }, 'owned renderer endpoint from own launcher logs');
  assert(cdp && port && app.pid);
  cdp.on('Runtime.exceptionThrown', (event) => faults.push(event));
  cdp.on('Runtime.consoleAPICalled', (event) => {
    if ((event as { type: string }).type === 'error') faults.push(event);
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await until(async () => {
    try {
      return await cdp!.evaluate(
        '(async()=>!!window.__agentTeamsDevStore && !!(await window.electronAPI.startup.getStatus()).ready)()'
      );
    } catch (e) {
      if (/execution context|No handler registered/i.test(String(e))) return false;
      throw e;
    }
  }, 'real IPC startup ready');
  await cdp.evaluate('window.__agentTeamsDevStore.getState().fetchAllTasks()');
  const names = fixture.teams.map((t) => t.teamName);
  await until(
    () =>
      cdp!.evaluate(
        `(${JSON.stringify(names)}).every(team=>window.__agentTeamsDevStore.getState().globalTasks.some(t=>t.teamName===team&&t.id==='1'))`
      ),
    'both TEST teams in real global task IPC'
  );
  await cdp.evaluate(
    `(()=>{window.__taskTabsColdPageEvents=[];window.__taskTabsColdPageUnsubscribe=window.electronAPI.teams.onTeamChange((_event,event)=>{if((${JSON.stringify(names)}).includes(event.teamName)){window.__taskTabsColdPageEvents.push({at:Date.now(),type:event.type,teamName:event.teamName,taskId:event.taskId,taskSignalKind:event.taskSignalKind});window.__taskTabsColdPageEvents=window.__taskTabsColdPageEvents.slice(-50);}});})()`
  );
  for (const team of fixture.teams) {
    const before = await cdp.evaluate(
      '(()=>{const s=window.__agentTeamsDevStore.getState();return {selectedTeamName:s.selectedTeamName,selectedProjectId:s.selectedProjectId};})()'
    );
    await cdp.evaluate(
      `(()=>{const s=window.__agentTeamsDevStore.getState();const opened=s.openTaskDetailTab({contextId:s.activeContextId,teamName:${JSON.stringify(team.teamName)},taskId:'1'});if(!opened)throw new Error('Actual task-tab activation refused');return opened;})()`
    );
    const inspect = () =>
      cdp!.evaluate(
        `(()=>{const s=window.__agentTeamsDevStore.getState();const e=Object.values(s.taskDetailById).find(e=>e.identity.contextId===s.activeContextId&&e.identity.teamName===${JSON.stringify(team.teamName)}&&e.identity.taskId==='1');return {at:Date.now(),activeContextId:s.activeContextId,selectedTeamName:s.selectedTeamName,selectedProjectId:s.selectedProjectId,phase:e?.phase,error:e?.error,loading:e?.loading,refreshPending:e?.refreshPending,fullToken:e?.fullToken,compactToken:e?.compactToken,fullId:e?.full?.id,descriptionTail:e?.full?.description?.slice(-60),commentCount:e?.full?.comments?.length,visibleHeading:Array.from(document.querySelectorAll('[data-task-detail-page]')).find(p=>p.getBoundingClientRect().width>0&&p.getBoundingClientRect().height>0)?.querySelector('h1')?.textContent,events:window.__taskTabsColdPageEvents};})()`
      );
    const expectedHeading = 'TEST ' + team.markers.description.slice(-1) + ' same ID task';
    const start = Date.now();
    let observed: unknown;
    while (Date.now() - start < 12000) {
      observed = await inspect();
      diagnostics.push(observed);
      if (
        (observed as { phase?: string; visibleHeading?: string }).phase === 'ready' &&
        (observed as { visibleHeading?: string }).visibleHeading?.includes(expectedHeading)
      )
        break;
      if (['unavailable', 'missing', 'deleted'].includes((observed as { phase: string }).phase))
        break;
      await pause(400);
    }
    const after = await cdp.evaluate(
      '(()=>{const s=window.__agentTeamsDevStore.getState();return {selectedTeamName:s.selectedTeamName,selectedProjectId:s.selectedProjectId};})()'
    );
    assert.deepEqual(after, before, 'Task tab changed global team/project selection');
    if (
      (observed as { phase?: string; visibleHeading?: string }).phase !== 'ready' ||
      !(observed as { visibleHeading?: string }).visibleHeading?.includes(expectedHeading)
    ) {
      await cdp.screenshot(join(root, 'electron-watcher-v7-failed.png'));
      // Diagnostic read only AFTER failure; it does not update store, click Retry, or turn the case green.
      const raw = await cdp.evaluate(
        `(async()=>{try{const t=await window.electronAPI.teams.getTask(${JSON.stringify(team.teamName)},'1');return {ok:true,id:t?.id,descriptionTail:t?.description?.slice(-60),commentCount:t?.comments?.length};}catch(error){return {ok:false,error:String(error)};}})()`
      );
      diagnostics.push({
        kind: 'direct-full-ipc-after-failed-page',
        teamName: team.teamName,
        result: raw,
      });
      assert.fail('Actual opened task page failed to become ready: ' + JSON.stringify(observed));
    }
    const fullContent = (await cdp.evaluate(
      `(()=>{const s=window.__agentTeamsDevStore.getState();const t=s.taskDetailById[JSON.stringify([s.activeContextId,${JSON.stringify(team.teamName)},'1'])]?.full;return {description:t?.description?.slice(-80),prompt:t?.prompt?.slice(-80),source:t?.sourceMessage?.text?.slice(-80),commentCount:t?.comments?.length,comment:t?.comments?.at(-1)?.text?.slice(-80),historyCount:t?.historyEvents?.length,history:t?.historyEvents?.at(-1)?.actor};})()`
    )) as {
      description?: string;
      prompt?: string;
      source?: string;
      commentCount?: number;
      comment?: string;
      historyCount?: number;
      history?: string;
    };
    assert(fullContent.description?.endsWith(team.markers.description));
    assert(fullContent.prompt?.endsWith(team.markers.prompt));
    assert(fullContent.source?.endsWith(team.markers.source));
    assert.equal(fullContent.commentCount, 125);
    assert(fullContent.comment?.endsWith(team.markers.comment + '_124'));
    assert.equal(fullContent.historyCount, 125);
    assert.equal(fullContent.history, team.markers.history);
    reads.push({
      teamName: team.teamName,
      fullContent,
      actualTaskPageReady: true,
      selectionPreserved: true,
      observed,
    });
  }
  const watcherMarkers = fixture.teams.map((team, i) => ({
    teamName: team.teamName,
    description: 'WATCHER_DESC_V7_' + i,
    comment: 'WATCHER_COMMENT_V7_' + i,
  }));
  for (let i = 0; i < fixture.teams.length; i++) {
    const team = fixture.teams[i];
    assert(team.taskFile.startsWith(root + '/claude/tasks/' + team.teamName + '/'));
    const task = JSON.parse(await readFile(team.taskFile, 'utf8'));
    task.description += watcherMarkers[i].description;
    task.comments.at(-1).text += watcherMarkers[i].comment;
    const temp = team.taskFile + '.watcher-v7.tmp';
    await writeFile(temp, JSON.stringify(task, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, team.taskFile);
  }
  let watcherObserved: unknown;
  const watcherStarted = Date.now();
  while (Date.now() - watcherStarted < 12000) {
    watcherObserved = await cdp.evaluate(
      `(()=>{const s=window.__agentTeamsDevStore.getState();const expectations=${JSON.stringify(watcherMarkers)};const tasks=expectations.map(w=>{const e=Object.values(s.taskDetailById).find(e=>e.identity.contextId===s.activeContextId&&e.identity.teamName===w.teamName&&e.identity.taskId==='1');return {teamName:w.teamName,phase:e?.phase,loading:e?.loading,refreshPending:e?.refreshPending,fullToken:e?.fullToken,descriptionTail:e?.full?.description?.slice(-70),commentTail:e?.full?.comments?.at(-1)?.text?.slice(-70),updated:e?.full?.description?.endsWith(w.description)&&e?.full?.comments?.at(-1)?.text?.endsWith(w.comment)};});return {at:Date.now(),tasks,events:window.__taskTabsColdPageEvents};})()`
    );
    diagnostics.push(watcherObserved);
    if ((watcherObserved as { tasks: { updated: boolean }[] }).tasks.every((t) => t.updated)) break;
    await pause(400);
  }
  await cdp.screenshot(join(root, 'electron-watcher-v7-after-external-write.png'));
  assert(
    (watcherObserved as { tasks: { updated: boolean }[] }).tasks.every((t) => t.updated),
    'Actual watcher did not refresh both open full tasks: ' + JSON.stringify(watcherObserved)
  );
  reads.push({
    kind: 'real-atomic-watcher-update',
    activeAndInactiveTasksUpdated: true,
    observed: watcherObserved,
  });
  // Exercise the actual dialog -> existing task-tab handoff, including a real FileReader attachment.
  const teamA = fixture.teams[0],
    teamB = fixture.teams[1];
  await cdp.evaluate(
    `(async()=>{const s=window.__agentTeamsDevStore.getState();await s.updateConfig('general',{appLocale:'ru'});const taskA=s.paneLayout.panes.flatMap(p=>p.tabs).find(t=>t.taskDetail&&t.teamName===${JSON.stringify(teamA.teamName)});if(!taskA)throw Error('Task A tab missing before cold handoff');s.closeTab(taskA.id);s.openGlobalTaskDetail(${JSON.stringify(teamA.teamName)},'1');})()`
  );
  await until(
    () => cdp!.evaluate(`!!document.querySelector('[role="dialog"] [data-task-detail-open-tab]')`),
    'loaded real task dialog with handoff button'
  );
  const label = await cdp.evaluate(
    `document.querySelector('[role="dialog"] [data-task-detail-open-tab]')?.textContent?.trim()`
  );
  assert.equal(label, 'Открыть в отдельной вкладке');
  await cdp.evaluate(
    `(()=>{const d=document.querySelector('[role="dialog"]');const t=d.querySelector('textarea[id^="task-comment-input-"]');if(!t||t.disabled)throw Error('Editable dialog composer missing');t.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'TEST_HANDOFF_DRAFT_V7');t.dispatchEvent(new Event('input',{bubbles:true}));const f=d.querySelector('input[type=file]');const dt=new DataTransfer();dt.items.add(new File(['TEST pending attachment V7'],'task-tabs-test-draft.txt',{type:'text/plain'}));f.files=dt.files;f.dispatchEvent(new Event('change',{bubbles:true}));})()`
  );
  const identityA = { contextId: 'local', teamName: teamA.teamName, taskId: '1' };
  await until(
    () =>
      cdp!.evaluate(
        `(()=>{const s=window.__agentTeamsDevStore.getState();const d=s.taskDetailSessionById[JSON.stringify([${JSON.stringify(identityA.contextId)},${JSON.stringify(identityA.teamName)},'1'])];return !!d&&d.commentText==='TEST_HANDOFF_DRAFT_V7'&&d.pendingAttachments.length===1;})()`
      ),
    'real dialog text and pending attachment in shared session',
    12000
  );
  await prepareRichTaskDraft(cdp, teamA.teamName);
  const beforeHandoff = await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();return {tabs:s.paneLayout.panes.flatMap(p=>p.tabs).filter(t=>t.taskDetail).length,owner:s.taskDetailSessionById[JSON.stringify([${JSON.stringify(identityA.contextId)},${JSON.stringify(identityA.teamName)},'1'])]?.ownerSurfaceId};})()`
  );
  const handoffPoint = (await cdp.evaluate(
    `(()=>{const b=document.querySelector('[role="dialog"] [data-task-detail-open-tab]');b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`
  )) as { x: number; y: number };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...handoffPoint });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...handoffPoint,
    button: 'left',
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...handoffPoint,
    button: 'left',
    clickCount: 1,
  });
  await until(
    () =>
      cdp!.evaluate(
        `(()=>{const s=window.__agentTeamsDevStore.getState();const d=s.taskDetailSessionById[JSON.stringify([${JSON.stringify(identityA.contextId)},${JSON.stringify(identityA.teamName)},'1'])];const p=s.paneLayout.panes.find(p=>p.tabs.some(t=>t.id===p.activeTabId&&t.teamName===${JSON.stringify(teamA.teamName)}&&t.taskDetail));return !s.globalTaskDetail&&p&&d?.ownerSurfaceId===p.activeTabId&&d.commentText.startsWith('TEST_HANDOFF_DRAFT_V7')&&d.commentChips.length===1&&d.reply?.text.includes('COMMENT_TAIL_A')&&d.descriptionDraft.includes('TESTDIRTYDESCRIPTIONHANDOFF')&&d.subjectDraft==='TEST_DIRTY_SUBJECT_HANDOFF'&&d.editingSubject&&d.pendingAttachments.length===1;})()`
      ),
    'task-tab handoff preserves draft and file with one owner',
    12000
  );
  const handoff = await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();const ids=[...document.querySelectorAll('[id^="task-comment-input-"]')].map(e=>e.id);return {tabs:s.paneLayout.panes.flatMap(p=>p.tabs).filter(t=>t.taskDetail).length,session:s.taskDetailSessionById[JSON.stringify([${JSON.stringify(identityA.contextId)},${JSON.stringify(identityA.teamName)},'1'])],uniqueComposerIds:ids.length===new Set(ids).size};})()`
  );
  assert.equal(
    (handoff as { tabs: number }).tabs,
    (beforeHandoff as { tabs: number }).tabs + 1,
    'Cold handoff did not create exactly one task tab'
  );
  assert((handoff as { uniqueComposerIds: boolean }).uniqueComposerIds, 'Composer IDs collide');
  const chipPaths = await cdp.evaluate(
    `window.__agentTeamsDevStore.getState().taskDetailSessionById[JSON.stringify(['local',${JSON.stringify(teamA.teamName)},'1'])]?.commentChips.map(chip=>chip.filePath)`
  );
  assert.deepEqual(
    chipPaths,
    [join(teamA.project, 'README.md')],
    'File chip used another task project'
  );
  const afterHandoffTask = JSON.parse(await readFile(teamA.taskFile, 'utf8')) as {
    subject: string;
    description: string;
    comments: unknown[];
  };
  assert.equal(
    afterHandoffTask.subject,
    'TEST A same ID task',
    'Handoff blur submitted dirty subject'
  );
  assert(
    afterHandoffTask.description.endsWith(watcherMarkers[0].description),
    'Handoff submitted dirty description'
  );
  assert.equal(afterHandoffTask.comments.length, 125, 'Handoff auto-sent a comment');
  reads.push({
    kind: 'actual-dialog-tab-handoff',
    label,
    draftAndFilePreserved: true,
    beforeHandoff,
    handoff,
  });
  const hiddenTask = JSON.parse(await readFile(teamB.taskFile, 'utf8')) as { description: string };
  hiddenTask.description += 'HIDDEN_RESOURCE_EXTERNAL_WRITE';
  await writeFile(teamB.taskFile + '.hidden.tmp', JSON.stringify(hiddenTask), {
    flag: 'wx',
    mode: 0o600,
  });
  await rename(teamB.taskFile + '.hidden.tmp', teamB.taskFile);
  await until(
    () =>
      cdp!.evaluate(
        `(()=>{const s=window.__agentTeamsDevStore.getState();return s.taskDetailById[JSON.stringify(['local',${JSON.stringify(teamB.teamName)},'1'])]?.full?.description?.endsWith('HIDDEN_RESOURCE_EXTERNAL_WRITE');})()`
      ),
    'hidden full task updated by real watcher'
  );
  await pause(500);
  const hidden = await cdp.evaluate(
    `(()=>{const s=window.__agentTeamsDevStore.getState();const entries=Object.values(s.taskDetailResourcesById).filter(e=>e.identity.teamName===${JSON.stringify(teamB.teamName)});return entries.map(e=>({kind:e.kind,loading:e.loading,refreshPending:e.refreshPending}));})()`
  );
  assert(
    (hidden as { loading: boolean; refreshPending: boolean }[]).length > 0,
    'No resource entry to prove hidden-state behavior'
  );
  assert(
    (hidden as { loading: boolean; refreshPending: boolean }[]).every(
      (e) => !e.loading && e.refreshPending
    ),
    'Hidden task resources revalidated'
  );
  reads.push({ kind: 'inactive-tab-resources-remain-dirty', hidden });
  await runSessionAndPaneCases(cdp, fixture, (value) => reads.push(value));
  await cdp.evaluate('window.__taskTabsColdPageUnsubscribe?.()');
  await cdp.screenshot(join(root, 'electron-cold-page-v3.png'));
  const audit = (await readFile(join(root, 'runtime-audit.ndjson'), 'utf8')).trim();
  if (audit)
    for (const line of audit.split('\n')) {
      const args = JSON.parse(line).args;
      assert(
        JSON.stringify(args) === JSON.stringify(['--version']) ||
          JSON.stringify(args) ===
            JSON.stringify([
              'runtime',
              'providers',
              'directory',
              '--runtime',
              'opencode',
              '--json',
              '--summary',
              '--filter',
              'all',
              '--limit',
              '100',
            ]) ||
          ['anthropic', 'opencode', 'codex'].some(
            (provider) =>
              JSON.stringify(args) ===
              JSON.stringify(['runtime', 'status', '--json', '--provider', provider, '--summary'])
          ),
        'Unexpected lifecycle attempt; shim blocked all non-version commands'
      );
    }
  assert.equal(faults.length, 0, 'Renderer faults');
  closeEvidence = await shutdown.gracefulClose(cdp, port, app.pid);
  passed = true;
} catch (error) {
  if (cdp) {
    try {
      diagnostics.push({
        kind: 'failure-ui',
        evidence: await cdp.evaluate(
          `(()=>{const s=window.__agentTeamsDevStore.getState();return {focused:document.hasFocus(),active:document.activeElement?.outerHTML?.slice(0,500),editable:[...document.querySelectorAll('[contenteditable=true]')].map(e=>e.innerHTML.slice(0,1000)),sessions:Object.values(s.taskDetailSessionById).map(d=>({owner:d.ownerSurfaceId,subject:d.subjectDraft,description:d.descriptionDraft.slice(-150),comment:d.commentText,reply:!!d.reply,chips:d.commentChips.length}))};})()`
        ),
      });
      await cdp.screenshot(join(root, 'failed.png'));
    } catch {
      /* Retain the original failure even if the renderer retired. */
    }
  }
  failure = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  try {
    if (app?.pid) await shutdown.stopOwnedGroup(app.pid);
  } catch (error) {
    passed = false;
    failure = (failure ?? '') + '\nCleanup: ' + String(error);
    process.exitCode = 1;
  }
  try {
    await cdp?.close();
  } catch (error) {
    passed = false;
    failure = (failure ?? '') + '\nCDP close: ' + String(error);
    process.exitCode = 1;
  }
  await writeFile(join(root, 'electron-cold-page-v3.log'), logs, { mode: 0o600 });
  await receipt();
  console.log(JSON.stringify({ passed, receiptPath, failure, fullTaskTabsE2E: false }));
}
