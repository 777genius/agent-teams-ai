/** Disposable desktop UI E2E. Operator supplies exact integrated SHA and its own DISPLAY.
 * node --import tsx scripts/e2e/task-folders-desktop.ts <40-character-source-sha>
 * No provider/team is launched. Every declared check is mandatory; failure retains all evidence.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Desktop, delay, fixture, json } from './task-folders/runtime.ts';
import { cardLayoutScenarios, folderUnreadPropagation } from './task-folders/mode-layout.ts';
import { narrowViewport } from './task-folders/narrow.ts';
import {
  filteredSidebarNativeMove,
  scopedSortAndFilters,
  sharedCardLiveUpdates,
  sharedCardParity,
} from './task-folders/shared-cards.ts';
import { UI, el, folderRow, label, selectors, taskRow } from './task-folders/ui.ts';
import type { Snapshot } from '../../src/features/task-folders/core/domain/folders.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const declared = [
  'fixture-isolation-and-seed',
  'manual-toggle-and-adjacent-geometry',
  'create-nested-and-rename',
  'native-folder-move-and-cycle-rejection',
  'native-sidebar-task-move-and-hidden-order',
  'native-tree-task-reorder',
  'archive-grey-accessible-and-restore-position',
  'keyboard-move-chooser',
  'delete-promotes-children',
  'enabled-mode-persists-after-release',
  'enabled-mode-persists-after-cancel',
  'enabled-mode-persists-after-pointer-leave',
  'enabled-mode-persists-after-edit',
  'enabled-mode-persists-after-portaled-menu',
  'virtualization-and-native-edge-scroll',
  'narrow-viewport',
  'missing-reference-reappears',
  'full-process-restart-persistence',
  'shared-card-panel-parity',
  'shared-card-live-actions',
  'scoped-task-sorting-and-filters',
  'filtered-sidebar-native-move',
  'folder-mode-layout-and-background',
  'folder-unread-task-count-propagation',
  'no-runtime-launch-or-renderer-faults',
] as const;
type Check = (typeof declared)[number];
async function main() {
  const sha = process.argv[2];
  assert(
    sha && /^[0-9a-f]{40}$/.test(sha),
    'Operator must supply exact tested integrated source SHA'
  );
  assert.equal(process.platform, 'linux', 'Hosted Linux harness');
  assert(process.env.DISPLAY, 'Operator must start an isolated Xvfb and supply DISPLAY');
  const scratch = process.env.TASK_FOLDERS_E2E_SCRATCH ?? path.join(repo, '.tool', 'scratch');
  await mkdir(scratch, { recursive: true });
  const harnessFiles = [
    'scripts/e2e/task-folders-desktop.ts',
    'scripts/e2e/task-folders/runtime.ts',
    'scripts/e2e/task-folders/ui.ts',
    'scripts/e2e/task-folders/deny-runtime.ts',
    'scripts/e2e/task-folders/shutdown.ts',
    'scripts/e2e/task-folders/narrow.ts',
    'scripts/e2e/task-folders/shared-cards.ts',
    'scripts/e2e/task-folders/mode-layout.ts',
    'scripts/tsconfig/tsconfig.desktop-e2e.json',
  ];
  const harnessHashes = Object.fromEntries(
    await Promise.all(
      harnessFiles.map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(path.join(repo, file)))
          .digest('hex'),
      ])
    )
  );
  const f = await fixture(repo);
  const taskHashes = Object.fromEntries(
    await Promise.all(
      f.taskIds.map(async (id) => [
        id,
        createHash('sha256')
          .update(await readFile(path.join(f.claude, 'tasks', f.team, id + '.json')))
          .digest('hex'),
      ])
    )
  );
  const desktop = new Desktop(repo, f);
  const ui = new UI(desktop);
  const sharedUI = new UI(desktop);
  const checks: { name: Check; passedAt: string; evidence?: unknown }[] = [];
  const screenshots: string[] = [];
  const sharedCardScreenshots: string[] = [];
  const snapshots: { label: string; snapshot: Snapshot }[] = [];
  let runtimeAuditUnexpectedCount = 0;
  let passed = false;
  let failure: string | undefined;
  const check = async (name: Check, operation: () => Promise<unknown>) => {
    assert(!checks.some((c) => c.name === name), 'Duplicate check');
    const evidence = await operation();
    checks.push({ name, passedAt: new Date().toISOString(), evidence });
    await receipt();
  };
  const screenshot = async (name: string) => {
    const file = path.join(f.root, 'screenshots', name + '.png');
    await ui.cdp.screenshot(file);
    screenshots.push(file);
  };
  const sharedScreenshot = async (name: string) => {
    const file = path.join(f.root, 'screenshots', name + '.png');
    await sharedUI.cdp.screenshot(file);
    sharedCardScreenshots.push(file);
  };
  const capture = async (name: string) => {
    const s = await ui.snapshot();
    snapshots.push({ label: name, snapshot: s });
    return s;
  };
  const screenshotNames = () =>
    [...screenshots, ...sharedCardScreenshots].map((file) => path.basename(file));
  const trustedDragCount = () =>
    [...ui.dragEvidence, ...sharedUI.dragEvidence].filter((e) =>
      e.observedDragStarts.some((start) => start.trusted)
    ).length;
  const receipt = async () =>
    json(path.join(f.root, 'receipt.json'), {
      kind: 'task-folders-desktop-v1',
      testedSourceSha: sha,
      shaAuthority: 'operator argument; no linked Git metadata access',
      passed,
      declaredChecks: declared,
      checks,
      selectors,
      harnessHashes,
      initialTaskFileHashes: taskHashes,
      screenshots,
      sharedCardScreenshots,
      snapshots,
      failure,
      consoleFaults: desktop.faults,
      nativeDrags: ui.dragEvidence,
      sharedCardNativeDrags: sharedUI.dragEvidence,
      finalCounts: {
        checks: checks.length,
        screenshots: screenshotNames().length,
        trustedDrags: trustedDragCount(),
        runtimeAuditUnexpected: runtimeAuditUnexpectedCount,
        rendererFaults: desktop.faults.length,
      },
      ownership: desktop.ownership,
      fixture: {
        root: f.root,
        project: f.project,
        team: f.team,
        claude: f.claude,
        userData: f.env.AGENT_TEAMS_ELECTRON_USER_DATA_DIR,
        tmp: f.env.TMPDIR,
      },
    });
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      await desktop.stop(!passed).catch((error) => {
        passed = false;
        failure = String(error);
        process.exitCode = 1;
      });
      await writeFile(
        path.join(f.root, 'desktop.log'),
        [...desktop.logHistory, desktop.logs].join('\n--- owned launch ---\n')
      );
      if (desktop.faults.length) {
        passed = false;
        process.exitCode = 1;
      }
      await receipt();
    })());
  const onSignal = (signal: NodeJS.Signals) => {
    passed = false;
    failure = 'Interrupted by ' + signal;
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const children = (s: Snapshot, id: string) =>
    s.folders.find((folder) => folder.id === id)!.children;
  const taskSource = (id: string) =>
    `${taskRow(f.team, id, selectors.sidebar)}.querySelector(${JSON.stringify(selectors.taskHandle)})`;
  const folderSource = (id: string) =>
    `${folderRow(id)}.querySelector(${JSON.stringify(selectors.folderHandle)})`;
  const remainsEnabled = async () => {
    await ui.unfocus();
    await delay(2300);
    await ui.assertFolderMode(true);
    return { enabledAfterOutsideFocusMs: 2300 };
  };
  const cancelledEnabledDrag = async () => {
    await ui.open();
    const data = await ui.beginDrag(taskSource('c'), { teamName: f.team, taskId: 'c' });
    const point = await ui.point(folderRow(f.parent));
    await ui.dragOver(data, point, true);
    await ui.finishDrag(data, point, true);
    await ui.move(point);
    return point;
  };
  const expandSeeds = async () => {
    await ui.expand(f.parent);
    await ui.expand(f.nested);
  };
  try {
    await desktop.start();
    await check('fixture-isolation-and-seed', async () => {
      await ui.cdp.evaluate(`(() => {
        if(localStorage.getItem('taskFolders:v1'))throw new Error('Fresh fixture already has folders');
        localStorage.setItem('taskFolders:v1',${JSON.stringify(JSON.stringify(f.snapshot))});
        localStorage.setItem('taskArchivedIds',${JSON.stringify(JSON.stringify([f.team + ':archived']))});
      })()`);
      const origin = await ui.value<string>('location.origin');
      await desktop.stop();
      await desktop.start();
      assert.equal(
        await ui.value('location.origin'),
        origin,
        'Seed restart storage origin changed'
      );
      assert.deepEqual(await ui.snapshot(), f.snapshot);
      assert.deepEqual(await ui.value('JSON.parse(localStorage.getItem("taskArchivedIds"))'), [
        f.team + ':archived',
      ]);
      return { folders: f.snapshot.folders.length, team: f.team, origin, seededStorageOnly: true };
    });
    await check('manual-toggle-and-adjacent-geometry', async () => {
      await ui.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 850,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await ui.open();
      await ui.unfocus();
      await delay(2200);
      assert(await ui.value(`!!${el(selectors.panel)}`), 'Manual panel did not stay open');
      const geometry = await ui.value<{
        right: number;
        sidebarLeft: number;
        top: number;
        sidebarTop: number;
        bottom: number;
        sidebarBottom: number;
      }>(`(() => {
        const p=${el(selectors.panel)}.getBoundingClientRect();
        const s=${el(selectors.toggle)}.closest('[data-testid="right-sidebar"]') || ${el(selectors.sidebar)}.parentElement.parentElement;
        const r=s.getBoundingClientRect();return {right:p.right,sidebarLeft:r.left,top:p.top,sidebarTop:r.top,bottom:p.bottom,sidebarBottom:r.bottom};})()`);
      assert(Math.abs(geometry.right - geometry.sidebarLeft) <= 2, JSON.stringify(geometry));
      assert(Math.abs(geometry.top - geometry.sidebarTop) <= 2, JSON.stringify(geometry));
      assert(Math.abs(geometry.bottom - geometry.sidebarBottom) <= 2, JSON.stringify(geometry));
      await screenshot('adjacent-panel');
      await ui.click(el(selectors.toggle));
      await ui.wait(`!${el(selectors.panel)}`, 'manual toggle close');
      await ui.assertFolderMode(false);
      await ui.attemptDisabledTaskDrag(f.team, 'c');
      await ui.open();
      await expandSeeds();
      return geometry;
    });
    let created = '';
    let deep = '';
    await check('create-nested-and-rename', async () => {
      created = await ui.create('Created nested', f.nested);
      deep = await ui.create('Deep child', created);
      await ui.menu(folderRow(created), 'Rename folder');
      await ui.fill(el('input[aria-label="Rename folder"]'), 'Renamed nested');
      await ui.key('Enter');
      await ui.persisted(
        (s) =>
          s.folders.some((folder) => folder.id === created && folder.name === 'Renamed nested'),
        'rename'
      );
      const s = await capture('nested-create-rename');
      assert(children(s, f.nested).some((c) => c.kind === 'folder' && c.id === created));
      assert.deepEqual(children(s, created), [{ kind: 'folder', id: deep }]);
    });
    await check('native-folder-move-and-cycle-rejection', async () => {
      const moving = await ui.create('Native moving root');
      await ui.drag(folderSource(moving), folderRow(created));
      await ui.persisted(
        (s) => children(s, created).some((c) => c.kind === 'folder' && c.id === moving),
        'native folder drop'
      );
      assert(!(await ui.snapshot()).rootFolderIds.includes(moving));
      const before = await ui.snapshot();
      await ui.drag(folderSource(f.parent), folderRow(deep));
      await delay(500);
      assert.deepEqual(
        await ui.snapshot(),
        before,
        'Descendant drop must reject without revision/order change'
      );
      await ui.menu(folderRow(f.parent), 'Move to…');
      await ui.click(label('Destination folder', el('[role="dialog"]')));
      await ui.wait('document.querySelector(\'[role="option"]\')', 'chooser options open');
      assert(
        await ui.value(
          `Array.from(document.querySelectorAll('[role="option"]')).every(e=>!e.textContent.includes('Deep child') && !e.textContent.includes('Seed parent'))`
        ),
        'Chooser offered self or descendant'
      );
      await ui.key('Escape');
      await ui.key('Escape');
      await capture('native-folder-and-invalid-cycle');
    });
    await check('native-sidebar-task-move-and-hidden-order', async () => {
      await ui.click(el(selectors.archived)); // Hide canonical archived sibling.
      assert.equal(
        await ui.value(`${el(selectors.archived)}.getAttribute('data-state')`),
        'unchecked'
      );
      const before = children(await ui.snapshot(), f.nested);
      await ui.drag(taskSource('c'), taskRow(f.team, 'b'), 0.08, { teamName: f.team, taskId: 'c' });
      const expected = [...before];
      expected.splice(
        expected.findIndex((c) => c.kind === 'task' && c.identity.taskId === 'b'),
        0,
        f.task('c')
      );
      await ui.persisted(
        (s) => JSON.stringify(children(s, f.nested)) === JSON.stringify(expected),
        'native sidebar drop before visible anchor'
      );
      assert.deepEqual(children(await ui.snapshot(), f.nested), expected);
      await ui.click(el(selectors.archived));
      await capture('hidden-canonical-order');
    });
    await check('native-tree-task-reorder', async () => {
      const before = children(await ui.snapshot(), f.nested);
      await ui.drag(
        `${taskRow(f.team, 'c')}.querySelector(${JSON.stringify(selectors.taskHandle)})`,
        taskRow(f.team, 'a'),
        0.08
      );
      const expected = before.filter((c) => !(c.kind === 'task' && c.identity.taskId === 'c'));
      expected.unshift(f.task('c'));
      await ui.persisted(
        (s) => JSON.stringify(children(s, f.nested)) === JSON.stringify(expected),
        'tree native reorder'
      );
      await capture('tree-reorder');
    });
    await check('archive-grey-accessible-and-restore-position', async () => {
      const before = await ui.snapshot();
      await ui.menu(taskRow(f.team, 'a'), 'Archive');
      await ui.wait(
        `${taskRow(f.team, 'a')}.querySelector('[aria-label="Archived task"]')`,
        'accessible archived icon'
      );
      const accessible = await ui.accessibility(taskRow(f.team, 'a'));
      assert.equal(accessible.role, 'treeitem');
      assert(accessible.name?.includes('TEST task a'), JSON.stringify(accessible));
      assert(
        /Archived task/i.test([accessible.name, accessible.description].join(' ')),
        JSON.stringify(accessible)
      );
      assert(
        await ui.value(`Number(getComputedStyle(${taskRow(f.team, 'a')}).opacity)<1`),
        'Archived row must be muted'
      );
      assert(
        await ui.value(`${taskRow(f.team, 'a')}.hasAttribute('tabindex')`),
        'Archived row must remain keyboard accessible'
      );
      assert.equal(
        await ui.value(`${el(selectors.archived)}.getAttribute('data-state')`),
        'checked'
      );
      assert.deepEqual(
        await ui.snapshot(),
        before,
        'Archive must preserve placement/order/revision'
      );
      await screenshot('nested-tree-archived');
      await ui.menu(taskRow(f.team, 'a'), 'Unarchive');
      await ui.wait(
        `!${taskRow(f.team, 'a')}.querySelector('[aria-label="Archived task"]')`,
        'restored active row'
      );
      const restored = await ui.accessibility(taskRow(f.team, 'a'));
      assert(
        !/Archived task/i.test([restored.name, restored.description].join(' ')),
        JSON.stringify(restored)
      );
      assert.deepEqual(await ui.snapshot(), before);
      return { archived: accessible, restored };
    });
    await check('keyboard-move-chooser', async () => {
      // Main sidebar handle has a keyboard equivalent; invoke Enter on the actual focused control.
      await ui.value(`${taskSource('b')}.focus()`);
      assert(
        await ui.value(
          `document.activeElement === ${taskSource('b')} && document.activeElement.matches('button,[role="button"]')`
        ),
        'Actual drag handle button must receive keyboard activation'
      );
      await ui.key('Enter');
      await ui.wait('document.querySelector(\'[role="dialog"]\')', 'keyboard move dialog');
      await ui.chooseDestination('Unfiled');
      await ui.submitMove('Move to…', 'keyboard move submitted');
      await ui.persisted(
        (s) =>
          !s.folders.some((folder) =>
            folder.children.some((c) => c.kind === 'task' && c.identity.taskId === 'b')
          ),
        'keyboard unfiled move'
      );
      await ui.click(taskSource('b'));
      await ui.chooseDestination('Seed parent / Seed nested / Renamed nested');
      await ui.submitMove('Move to…', 'folder move submitted');
      await ui.persisted(
        (s) => children(s, created).some((c) => c.kind === 'task' && c.identity.taskId === 'b'),
        'chooser move to folder'
      );
      return { destination: 'Unfiled', sourceKey: JSON.stringify([f.team, 'b']) };
    });
    await check('delete-promotes-children', async () => {
      await ui.menu(folderRow(created), 'Delete folder');
      await ui.wait('document.querySelector(\'[role="dialog"]\')', 'delete confirmation');
      assert(
        await ui.value(
          `document.querySelector('[role="dialog"]').textContent.includes('No tasks are deleted')`
        )
      );
      const before = await ui.snapshot();
      const index = children(before, f.nested).findIndex(
        (c) => c.kind === 'folder' && c.id === created
      );
      const expected = [...children(before, f.nested)];
      expected.splice(index, 1, ...children(before, created));
      await ui.click(label('Delete folder', el('[role="dialog"]')));
      await ui.persisted((s) => !s.folders.some((folder) => folder.id === created), 'delete');
      assert.deepEqual(children(await ui.snapshot(), f.nested), expected);
      await capture('delete-promotes-ordered-children');
    });
    await check('enabled-mode-persists-after-release', async () => {
      await ui.open();
      await ui.drag(taskSource('b'), folderRow(f.parent), 0.5, { teamName: f.team, taskId: 'b' });
      await ui.persisted(
        (s) => children(s, f.parent).some((c) => c.kind === 'task' && c.identity.taskId === 'b'),
        'release drop'
      );
      await ui.waitDropFocusRestored();
      return await remainsEnabled();
    });
    await check('enabled-mode-persists-after-cancel', async () => {
      const before = await ui.snapshot();
      const data = await ui.beginDrag(taskSource('c'), { teamName: f.team, taskId: 'c' });
      await ui.finishDrag(data, { x: 10, y: 80 }, true);
      const timing = await remainsEnabled();
      assert.deepEqual(await ui.snapshot(), before);
      return timing;
    });
    await check('enabled-mode-persists-after-pointer-leave', async () => {
      await cancelledEnabledDrag();
      await delay(2300);
      assert(await ui.value(`!!${el(selectors.panel)}`), 'Enabled mode disappeared after hover');
      return await remainsEnabled();
    });
    await check('enabled-mode-persists-after-edit', async () => {
      await cancelledEnabledDrag();
      await ui.menu(folderRow(f.parent), 'Rename folder');
      await ui.move({ x: 10, y: 80 });
      await delay(2300);
      assert(
        await ui.value(
          `!!${el(selectors.panel)} && !!document.querySelector('input[aria-label="Rename folder"]')`
        )
      );
      await ui.key('Escape');
      return await remainsEnabled();
    });
    await check('enabled-mode-persists-after-portaled-menu', async () => {
      await cancelledEnabledDrag();
      await ui.menu(folderRow(f.parent));
      assert(
        await ui.value(`!${el(selectors.panel)}.contains(document.querySelector('[role="menu"]'))`),
        'Menu must be portaled'
      );
      await ui.move({ x: 10, y: 80 });
      await delay(2300);
      assert(
        await ui.value(`!!${el(selectors.panel)} && !!document.querySelector('[role="menu"]')`)
      );
      await ui.key('Escape');
      await ui.waitMenuClosedAndFocusRestored(folderRow(f.parent));
      return await remainsEnabled();
    });
    await check('virtualization-and-native-edge-scroll', async () => {
      await ui.open();
      await ui.value(`${el(selectors.tree)}.scrollTop=0`);
      await delay(100);
      const mounted = await ui.value<number>(
        `${el(selectors.tree)}.querySelectorAll('[role="treeitem"]').length`
      );
      assert(mounted < 100, 'Large fixture is not virtualized: ' + mounted);
      const data = await ui.beginDrag(folderSource(f.parent));
      const point = await ui.value<{ x: number; y: number }>(
        `(() => {const r=${el(selectors.tree)}.getBoundingClientRect();return {x:r.x+r.width/2,y:r.bottom-4};})()`
      );
      await ui.dragOver(data, point, true);
      await ui.dragOver(data, point);
      // Rows keep scrolling under the stationary edge cursor, so Chromium retargets the
      // dispatched dragOver into dragenter; delivery of either feeds the app's edge over().
      await ui.assertNativeDragPair(point, 'native edge center', data, true);
      const before = await ui.value<number>(`${el(selectors.tree)}.scrollTop`);
      // Stationary pointer: RAF edge scroll must continue without repeated dragover events.
      await delay(1600);
      const after = await ui.value<number>(`${el(selectors.tree)}.scrollTop`);
      assert(after > before + 100, 'Native edge auto-scroll did not advance');
      assert(
        await ui.value(`!!${folderRow(f.parent)}`),
        'Native source must stay mounted outside visible range'
      );
      const center = await ui.value<{ x: number; y: number }>(
        `(() => {const r=${el(selectors.tree)}.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`
      );
      await ui.dragOver(data, center, true);
      await ui.dragOver(data, center);
      await ui.assertNativeDragPair(center, 'native tree center', data);
      const centerScrollTop = await ui.waitForStableScroll();
      const selected = await ui.visibleFolderCenter(f.parent);
      const target = selected.folderId;
      await ui.dragOver(data, selected, true);
      await ui.dragOver(data, selected);
      const selectedPair = await ui.assertNativeDragPair(selected, 'selected native drop target', data);
      const dropTarget = await ui.folderPoint(target, true);
      assert.equal(dropTarget.hitFolderId, target, 'Drop target identity changed after reacquire');
      assert(selectedPair.over, 'Selected native dragover pair missing');
      assert.equal(selectedPair.over.folderId, target, 'Observed dragover folder identity changed');
      assert.equal(selectedPair.over.insideTree, true, 'Observed selected dragover was outside the tree');
      if (selectedPair.enter)
        assert.equal(selectedPair.enter.folderId, target, 'Observed dragenter folder identity changed');
      await ui.finishDrag(data, dropTarget);
      await ui.persisted(
        (s) => children(s, target).some((c) => c.kind === 'folder' && c.id === f.parent),
        'post auto-scroll native drop'
      );
      await ui.locate(folderRow(target));
      // Undo through visible UI, preserving missing canonical references.
      await ui.expand(target);
      await ui.menu(folderRow(f.parent), 'Move to…');
      await ui.chooseDestination('Root');
      await ui.submitMove('Move to…', 'root move submitted');
      const locateParent = `JSON.stringify((() => {const s=JSON.parse(localStorage.getItem('taskFolders:v1'));
        const hit=s.folders.find((f)=>f.children.some((c)=>c.kind==='folder'&&c.id===${JSON.stringify(f.parent)}));
        return {parent:hit?.name ?? null,inRoot:s.rootFolderIds.includes(${JSON.stringify(f.parent)})};})())`;
      const firstPlace = await ui.value<string>(locateParent);
      try {
        await ui.persisted((s) => s.rootFolderIds.includes(f.parent), 'move back to Root');
      } catch (error) {
        const where = await ui.value<string>(locateParent);
        throw new Error(
          String(error) +
            ' | right after submit: ' +
            firstPlace +
            ' | at timeout: ' +
            where
        );
      }
      return {
        mountedRows: mounted,
        fixtureTasks: 1004,
        scrollBefore: before,
        scrollAfter: after,
        centerScrollTop,
        nativeDropTarget: target,
      };
    });
    await check('narrow-viewport', () => narrowViewport(ui, f, screenshot));
    await check('missing-reference-reappears', async () => {
      await ui.value(`${el(selectors.tree)}.scrollTop=0`);
      await expandSeeds();
      const before = await ui.snapshot();
      assert(
        children(before, f.nested).some((c) => c.kind === 'task' && c.identity.taskId === 'missing')
      );
      assert(
        await ui.value<boolean>(
          `Boolean(${folderRow(f.nested)}.querySelector('[aria-label*="1 unavailable"]'))`
        )
      );
      await json(path.join(f.claude, 'tasks', f.team, 'missing.json'), {
        id: 'missing',
        subject: 'TEST restored reference',
        description: 'Fixture reappearance',
        status: 'pending',
        owner: 'team-lead',
        blocks: [],
        blockedBy: [],
        comments: [],
      });
      await ui.cdp.evaluate('window.__agentTeamsDevStore.getState().fetchAllTasks()');
      await ui.wait(taskRow(f.team, 'missing'), 'returned task in original folder');
      assert.deepEqual(
        await ui.snapshot(),
        before,
        'Catalog refresh must preserve canonical references/order'
      );
      assert(
        await ui.value<boolean>(
          `Boolean(${folderRow(f.nested)}.querySelector('[aria-label*="0 unavailable"]'))`
        )
      );
    });
    await check('full-process-restart-persistence', async () => {
      const before = await capture('before-restart');
      const archives = await ui.value<string>('localStorage.getItem("taskArchivedIds")');
      await ui.assertFolderMode(true);
      const origin = await ui.value<string>('location.origin');
      await desktop.stop();
      await desktop.start();
      assert.equal(
        await ui.value('location.origin'),
        origin,
        'Storage origin changed across restart'
      );
      assert.deepEqual(await ui.snapshot(), before);
      assert.equal(await ui.value('localStorage.getItem("taskArchivedIds")'), archives);
      await ui.assertFolderMode(false);
      await ui.open();
      await expandSeeds();
      await ui.wait(
        `${taskRow(f.team, 'archived')}.querySelector('[aria-label="Archived task"]')`,
        'archived task survives process restart'
      );
      const accessible = await ui.accessibility(taskRow(f.team, 'archived'));
      assert.equal(accessible.role, 'treeitem');
      assert(accessible.name?.includes('TEST task archived'), JSON.stringify(accessible));
      assert(
        /Archived task/i.test([accessible.name, accessible.description].join(' ')),
        JSON.stringify(accessible)
      );
      await capture('after-restart');
      return { origin, accessibility: accessible };
    });
    await check('shared-card-panel-parity', () =>
      sharedCardParity(sharedUI, f, sharedScreenshot)
    );
    await check('shared-card-live-actions', () => sharedCardLiveUpdates(sharedUI, f));
    await check('scoped-task-sorting-and-filters', () => scopedSortAndFilters(sharedUI, f));
    await check('filtered-sidebar-native-move', async () =>
      filteredSidebarNativeMove(sharedUI, f, await sharedUI.snapshot())
    );
    await check('folder-mode-layout-and-background', async () => {
      await ui.open();
      await expandSeeds();
      return await cardLayoutScenarios(ui, f.team, 'a', true, screenshot);
    });
    await check('folder-unread-task-count-propagation', () => folderUnreadPropagation(ui, f, screenshot));
    await check('no-runtime-launch-or-renderer-faults', async () => {
      const audit = (await readFile(f.audit, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      assert(
        audit.every(
          (args) =>
            args[0] === '--version' ||
            (args[0] === 'runtime' && ['status', 'providers', 'opencode-command'].includes(args[1]))
        ),
        'Unexpected provider/runtime lifecycle request'
      );
      for (const id of f.taskIds)
        assert.equal(
          createHash('sha256')
            .update(await readFile(path.join(f.claude, 'tasks', f.team, id + '.json')))
            .digest('hex'),
          taskHashes[id],
          'UI organization changed task file ' + id
        );
      assert.equal(
        ui.dragEvidence.length,
        12,
        'Expected exactly 12 genuine beginDrag evidence entries'
      );
      assert.deepEqual(desktop.faults, [], 'Renderer exceptions or console errors');
      return { runtimeAudit: audit };
    });
    assert.deepEqual(
      checks.map((c) => c.name),
      [...declared],
      'Every declared check must pass'
    );
    assert.deepEqual(
      screenshots.map((file) => path.basename(file)),
      ['adjacent-panel.png', 'nested-tree-archived.png', 'narrow-360.png', 'narrow-440.png',
        'folder-layout-long-subject.png', 'folder-unread-propagation.png']
    );
    const finalAudit = (await readFile(f.audit, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const runtimeAuditUnexpected = finalAudit.filter(
      (args) =>
        !(
          args[0] === '--version' ||
          (args[0] === 'runtime' &&
            ['status', 'providers', 'opencode-command'].includes(args[1]))
        )
    );
    runtimeAuditUnexpectedCount = runtimeAuditUnexpected.length;
    assert.equal(checks.length, 25, 'Expected exactly 25 passed checks');
    assert.deepEqual(
      screenshotNames(),
      [
        'adjacent-panel.png',
        'nested-tree-archived.png',
        'narrow-360.png',
        'narrow-440.png',
        'folder-layout-long-subject.png',
        'folder-unread-propagation.png',
        'shared-cards-live.png',
      ],
      'Expected exactly 7 screenshots: 4 original, 2 mode/unread and 1 shared-card'
    );
    assert.equal(ui.dragEvidence.length, 12, 'Original suite must retain 12 native drags');
    assert.equal(sharedUI.dragEvidence.length, 1, 'Shared suite must add exactly 1 native drag');
    assert.equal(trustedDragCount(), 13, 'Expected exactly 13 trusted native drags');
    assert.equal(runtimeAuditUnexpectedCount, 0, 'Unexpected runtime audit entries');
    assert.equal(desktop.faults.length, 0, 'Renderer exceptions or console errors');
    passed = true;
  } catch (error) {
    failure = error instanceof Error ? error.stack : String(error);
    if (desktop.cdp) {
      await screenshot('failure').catch(() => undefined);
      await writeFile(
        path.join(f.root, 'failure-body.txt'),
        await ui.value<string>('document.body.innerText').catch(() => 'Renderer unavailable')
      );
    }
    process.exitCode = 1;
  } finally {
    await cleanup();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    console.log(JSON.stringify({ passed, receipt: path.join(f.root, 'receipt.json'), failure }));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
