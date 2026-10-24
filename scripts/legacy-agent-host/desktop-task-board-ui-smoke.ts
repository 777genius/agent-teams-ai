import { runDesktopTaskBoardAttachmentsUi } from './desktop-task-board-attachments-ui.ts';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createTeamController } from '../../packages/legacy-agent-host/dist/adapters/team/ControllerAdapter.js';
import { fileDigest } from './desktop-backend-fixture.ts';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

const teamName = 'test-desktop-backend';
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const json = async (path: string) => record(JSON.parse(await readFile(path, 'utf8')));
const pause = () => new Promise<void>((done) => setTimeout(done, 100));

/** Existing Create, assignee, clarification and sortable card controls; offline TEST owner only. */
export async function runDesktopTaskBoardUiSmoke(
  cdp: UiCdpPort,
  options: {
    root: string;
    repo: string;
    handleId: string;
    seed: { taskId: string; subject: string; commandId: string };
    assertOwnedRenderer(): void;
    evidence: Record<string, unknown>;
  }
): Promise<void> {
  assert.equal(await realpath(options.root), options.root);
  assert.match(basename(options.root), /^TEST-desktop-backend-/);
  const profile = await json(join(options.root, 'host-profile.json'));
  assert.equal(record(profile.owner).storageRoot, join(options.root, 'hoststore'));
  assert.equal(profile.principalId, 'TEST-human');
  assert.equal(profile.runtime, undefined, 'this flow never starts a native provider');
  const taskDirectory = join(options.root, 'hoststore/tasks', teamName);
  const teamDirectory = join(options.root, 'hoststore/teams', teamName);
  const commandDirectory = join(teamDirectory, '.host-owner/commands');
  const task = (id: string) => json(join(taskDirectory, `${id}.json`));
  const rows = async (directory: string) => {
    const names = (await readdir(directory)).filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name));
    assert.ok(names.length <= 128, 'bounded TEST product census');
    return Promise.all(names.sort().map((name) => json(join(directory, name))));
  };
  const commands = () => rows(commandDirectory);
  const steps: Record<string, unknown>[] = [];
  const step = (row: Record<string, unknown>) =>
    steps.push({ monotonicMs: Math.round(performance.now()), ...row });
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE',
    steps,
    scope:
      'Original Create Task dependency picker, Task assignee/Mark resolved, sortable TODO cards and blocked Start/Complete controls; offline canonical Host persistence',
    qaInventory: [
      'Create dependency through original optional fields; reciprocal canonical graph and visible blocker',
      'Change assignee through existing Radix MemberSelect; retained captured owner',
      'TEST API sets clarification because no set control exists; original Mark resolved clears it',
      'Columns/Manual controls and one trusted pointer drag change canonical column order',
      'Blocked Start refuses unresolved dependency; exact detached canonical oracle; same control succeeds after actual blocker Complete',
      'Renderer reload retains original task IDs, assignment, clarification and order without new commands',
      'Existing Task PNG and comment text file upload; canonical refs, reload/read/download and Task image removal',
    ],
    excluded: [
      'native agents/inference',
      'logs or runtime readiness',
      'nonexistent add/remove relationship UI',
      'full Stage1',
      'visual signoff before screenshot review',
    ],
    sourceSha256: await fileDigest(import.meta.filename),
  };
  options.evidence.taskBoardUiProof = proof;
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step,
  });
  const input = (
    method: 'Input.insertText' | 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent',
    params: Record<string, unknown>
  ) => {
    options.assertOwnedRenderer();
    return cdp.send(method, params);
  };
  const waitProduct = async <T>(
    read: () => Promise<T>,
    matches: (value: T) => boolean,
    label: string
  ): Promise<T> => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      options.assertOwnedRenderer();
      const value = await read();
      if (matches(value)) return value;
      await pause();
    }
    throw new Error(`Task board product read timed out: ${label}; no mutation retry`);
  };
  const screenshot = async (name: string) => {
    options.assertOwnedRenderer();
    const capture = record(
      await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    );
    assert.equal(typeof capture.data, 'string');
    const path = join(options.root, name);
    await writeFile(path, Buffer.from(String(capture.data), 'base64'), { mode: 0o600, flag: 'wx' });
    return { path, sha256: await fileDigest(path) };
  };
  // Expressions below only inspect current DOM. Input events remain the only UI actions.
  const measuredClick = async (expression: string, label: string) => {
    const point = record(await ui.waitRead(expression, label));
    assert.equal(typeof point.x, 'number');
    assert.equal(typeof point.y, 'number');
    options.assertOwnedRenderer();
    step({ action: 'mouseClick', label, target: point, state: 'attempted' });
    await input('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
    await input('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
  };
  const pointOf = (body: string) =>
    `(() => { const e=(()=>{${body}})();if(!e)return null;const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return r.width>0&&r.height>0&&hit&&(e===hit||e.contains(hit))&&!e.disabled?{x,y}:null; })()`;
  const card = (id: string) => `.kanban-task-card[data-task-id="${id}"]`;
  const receiptFor = async (
    operation: string,
    taskId: string,
    predicate: (payload: Record<string, unknown>) => boolean = () => true
  ) => {
    const found = await waitProduct(
      commands,
      (all) =>
        all.some((row) => {
          const command = record(row.command),
            payload = record(command.payload);
          return (
            ['completed', 'rejected'].includes(String(row.phase)) &&
            row.principalId === 'TEST-human' &&
            command.operation === operation &&
            payload.taskId === taskId &&
            predicate(payload)
          );
        }),
      operation
    );
    const matches = found.filter((row) => {
      const command = record(row.command),
        payload = record(command.payload);
      return (
        ['completed', 'rejected'].includes(String(row.phase)) &&
        row.principalId === 'TEST-human' &&
        command.operation === operation &&
        payload.taskId === taskId &&
        predicate(payload)
      );
    });
    assert.equal(matches.length, 1, 'exactly one business intent per actual control');
    return matches[0]!;
  };
  const before = await rows(taskDirectory);
  assert.equal(before.length, 1);
  assert.equal(before[0]!.id, options.seed.taskId);
  await ui.observeInput();
  await ui.clickSidebar(options.seed.subject);
  await ui.waitRead(
    `Boolean(document.querySelector(${JSON.stringify(card(options.seed.taskId))}))`,
    'canonical seed card'
  );
  proof.initialScreenshot = await screenshot('ui-task-board-initial.png');

  await ui.click('button', 'open existing Create Task dialog', 'Task');
  await ui.click('[role="dialog"] #task-subject', 'focus ordinary Subject');
  const subject = 'TEST ordinary dependent board task';
  await input('Input.insertText', { text: subject });
  await ui.click(
    '[role="dialog"] button',
    'show existing optional dependency fields',
    'Show optional fields'
  );
  const blockerButton = `(() => {
    const label=[...document.querySelectorAll('[role="dialog"] label')].find(e=>e.textContent.trim()==='Blocked by tasks (optional)');
    const buttons=label?[...label.parentElement.querySelectorAll('button')].filter(e=>[...e.querySelectorAll('span')].some(s=>s.textContent.trim()===${JSON.stringify(options.seed.subject)})):[];
    return buttons.length===1?buttons[0]:null;
  })()`;
  // Wheel input reveals optional fields without scrollIntoView or synthetic app events.
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await cdp.evaluate(pointOf(`return ${blockerButton};`))) break;
    const dialog = record(
      await ui.waitRead(
        pointOf('return document.querySelector(\'[role="dialog"]\');'),
        'visible original Task dialog'
      )
    );
    await input('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: dialog.x,
      y: dialog.y,
      deltaX: 0,
      deltaY: 350,
    });
    await pause();
  }
  await measuredClick(
    pointOf(`return ${blockerButton};`),
    'choose original Blocked by task option once'
  );
  await ui.scrollTo('[role="dialog"] button', 'original Create Task control', 'Create');
  await ui.click('[role="dialog"] button', 'submit original dependent Task once', 'Create');
  await ui.waitRead(
    `!document.querySelector('[role="dialog"] #task-subject')`,
    'Create Task closes'
  );
  const afterCreate = await waitProduct(
    () => rows(taskDirectory),
    (all) => all.length === 2,
    'one UI-created task'
  );
  const created = afterCreate.filter((row) => row.subject === subject);
  assert.equal(created.length, 1);
  const taskId = String(created[0]!.id);
  assert.match(taskId, /^[a-f0-9-]{36}$/);
  assert.equal(created[0]!.status, 'pending');
  assert.deepEqual(created[0]!.blockedBy, [options.seed.taskId]);
  assert.deepEqual((await task(options.seed.taskId)).blocks, [taskId]);
  const creates = (await commands()).filter(
    (row) =>
      record(row.command).operation === 'task.create' &&
      record(record(row.command).payload).subject === subject
  );
  assert.equal(creates.length, 1);
  assert.equal(creates[0]!.phase, 'completed');
  proof.createReceipt = creates[0];

  // No current UI sets clarification. This is explicit TEST setup, never a signoff action.
  options.assertOwnedRenderer();
  const setupCommandId = 'TEST-task-board-clarification-setup';
  const setup = record(
    await cdp.evaluate(
      `window.electronAPI.agentBackend.invoke(${JSON.stringify({ handle: { handleId: options.handleId }, commandId: setupCommandId, operation: 'task.clarification', payload: { taskId, value: 'user' } })})`
    )
  );
  assert.equal(setup.ok, true);
  assert.equal(record(setup.value).phase, 'completed');
  step({
    fixtureAction: 'captured TEST owner clarification setup',
    commandId: setupCommandId,
    taskId,
  });
  await ui.click(`${card(taskId)} h5`, 'open original Task detail');
  await ui.waitRead(
    `document.querySelector('[role="dialog"]')?.textContent.includes('Awaiting clarification from you')`,
    'existing clarification banner'
  );
  await ui.click('[role="dialog"] button[role="combobox"]', 'open original assignee picker');
  await ui.click('[cmdk-item][data-value="alice"]', 'assign alice through original member option');
  await waitProduct(
    () => task(taskId),
    (row) => row.owner === 'alice',
    'canonical Task assignment'
  );
  proof.assignmentReceipt = await receiptFor(
    'task.assign',
    taskId,
    (payload) => payload.owner === 'alice'
  );
  await ui.waitRead(
    `[...document.querySelectorAll('[role="dialog"] button')].some(e => e.textContent.trim() === ${JSON.stringify('#' + String(before[0]!.displayId))})`,
    'original dependency reference visible'
  );
  proof.dependencyScreenshot = await screenshot('ui-task-board-assigned-blocked.png');
  await ui.click('[role="dialog"] button', 'clear original clarification once', 'Mark resolved');
  await ui.waitRead(
    `!document.querySelector('[role="dialog"]')?.textContent.includes('Awaiting clarification from you')`,
    'clarification banner cleared'
  );
  assert.equal((await task(taskId)).needsClarification, undefined);
  proof.clarificationReceipt = await receiptFor(
    'task.clarification',
    taskId,
    (payload) => payload.value === null
  );
  await ui.click('[role="dialog"] button', 'close original Task detail', 'Close');
  await ui.waitRead(`!document.querySelector('[role="dialog"]')`, 'Task detail closed');

  await ui.click('button[aria-label="Columns view"]', 'switch existing board to Columns');
  await ui.click('button[aria-label="Sort tasks"]', 'open existing sort controls');
  await measuredClick(
    pointOf(
      `return [...document.querySelectorAll('button')].find(e=>e.querySelector('.font-medium')?.textContent.trim()==='Manual');`
    ),
    'choose original Manual sorting'
  );
  await ui.click('button[aria-label="Sort tasks"]', 'close sort popover');
  const orderBefore = await ui.waitRead(
    `(() => {const cards=[...document.querySelectorAll('.kanban-task-card[data-task-id]')];if(cards.length!==2||cards.some(e=>!e.parentElement.hasAttribute('aria-roledescription')))return null;return cards.map(e=>e.dataset.taskId);})()`,
    'two original sortable cards'
  );
  assert.ok(Array.isArray(orderBefore) && orderBefore.length === 2);
  const dragged = String(orderBefore[1]),
    target = String(orderBefore[0]);
  const geometry = record(
    await ui.waitRead(
      `(() => {
    const a=document.querySelector(${JSON.stringify(card(dragged))}),b=document.querySelector(${JSON.stringify(card(target))});if(!a||!b)return null;
    const p=a.getBoundingClientRect(),q=b.getBoundingClientRect();
    if(!p.width||!q.width||p.top<0||q.top<0||p.bottom>innerHeight||q.bottom>innerHeight)return null;
    return {x:p.x+Math.min(100,p.width/2),y:p.y+20,toX:q.x+Math.min(100,q.width/2),toY:q.y+20};
  })()`,
      'visible sortable source and destination'
    )
  );
  for (const key of ['x', 'y', 'toX', 'toY']) assert.equal(typeof geometry[key], 'number');
  const x = Number(geometry.x),
    y = Number(geometry.y),
    toX = Number(geometry.toX),
    toY = Number(geometry.toY);
  step({ action: 'pointerDrag', state: 'attempted', dragged, target, geometry });
  options.assertOwnedRenderer();
  await input('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await input('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  let releaseX = x,
    releaseY = y;
  try {
    for (let move = 1; move <= 12; move++) {
      options.assertOwnedRenderer();
      releaseX = x + ((toX - x) * move) / 12;
      releaseY = y + ((toY - y) * move) / 12;
      await input('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: releaseX,
        y: releaseY,
        button: 'left',
        buttons: 1,
      });
      if (move === 1) {
        // PointerSensor activates after 8px; its first qualifying move starts
        // the drag but does not translate it. Observe React's active state
        // before continuing this same held-pointer gesture.
        const active = await ui.waitRead(
          `(() => {const e=document.querySelector(${JSON.stringify(card(dragged))})?.parentElement;return e?.getAttribute('aria-pressed')==='true'?{taskId:${JSON.stringify(dragged)},pressed:e.getAttribute('aria-pressed'),transform:e.style.transform}:null;})()`,
          'original sortable source activates during the single drag',
          5_000
        );
        step({ observation: 'original sortable drag activated', value: active });
      }
      await new Promise<void>((done) => setTimeout(done, 25));
    }
    const collision = await ui.waitRead(
      `(() => {const e=document.querySelector(${JSON.stringify(card(dragged))})?.parentElement;const text=[...document.querySelectorAll('[id^="DndLiveRegion-"]')].map(e=>e.textContent).find(text=>text===${JSON.stringify(`Draggable item ${dragged} was moved over droppable area ${target}.`)});return e?.getAttribute('aria-pressed')==='true'&&text?{dragged:${JSON.stringify(dragged)},target:${JSON.stringify(target)},announcement:text}:null;})()`,
      'existing sortable accessibility announcement confirms the target before release',
      5_000
    );
    step({ observation: 'original sortable drag target acquired', value: collision });
  } finally {
    // Exactly one release also closes a gesture whose read-only handshake failed.
    await input('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: releaseX,
      y: releaseY,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    step({
      observation: 'single original drag delivery after release',
      value: await cdp.evaluate(
        `({moves:window.__TEST_desktopDragEvents??[],input:(window.__TEST_desktopInputEvents??[]).slice(-8),announcements:[...document.querySelectorAll('[id^="DndLiveRegion-"]')].map(e=>e.textContent)})`
      ),
    });
  }
  const expectedOrder = [dragged, target];
  const orderReceiptRows = await waitProduct(
    commands,
    (all) =>
      all.some(
        (row) => row.phase === 'completed' && record(row.command).operation === 'task.board.order'
      ),
    'one actual drag business receipt'
  );
  const orders = orderReceiptRows.filter(
    (row) => record(row.command).operation === 'task.board.order'
  );
  assert.equal(orders.length, 1);
  assert.equal(orders[0]!.phase, 'completed');
  assert.deepEqual(record(record(orders[0]!.command).payload), {
    columnId: 'todo',
    orderedTaskIds: expectedOrder,
  });
  assert.deepEqual(
    record((await json(join(teamDirectory, 'kanban-state.json'))).columnOrder).todo,
    expectedOrder
  );
  await ui.waitRead(
    `JSON.stringify([...document.querySelectorAll('.kanban-task-card[data-task-id]')].map(e=>e.dataset.taskId))===${JSON.stringify(JSON.stringify(expectedOrder))}`,
    'new order visible after actual drag'
  );
  proof.orderReceipt = orders[0];
  proof.reorderedScreenshot = await screenshot('ui-task-board-reordered.png');

  // Exact canonical negative oracle on detached TEST bytes distinguishes dependency refusal from other errors.
  const oracleRoot = join(options.root, 'task-board-dependency-oracle');
  await mkdir(join(oracleRoot, 'teams', teamName), { recursive: true, mode: 0o700 });
  await mkdir(join(oracleRoot, 'tasks', teamName), { recursive: true, mode: 0o700 });
  await writeFile(
    join(oracleRoot, 'teams', teamName, 'config.json'),
    await readFile(join(teamDirectory, 'config.json')),
    { mode: 0o600, flag: 'wx' }
  );
  for (const id of [options.seed.taskId, taskId])
    await writeFile(
      join(oracleRoot, 'tasks', teamName, `${id}.json`),
      await readFile(join(taskDirectory, `${id}.json`)),
      { mode: 0o600, flag: 'wx' }
    );
  let blockedReason: string | undefined;
  try {
    createTeamController(oracleRoot, teamName, true).taskBoard.startTask(taskId, 'user');
  } catch (error) {
    blockedReason = error instanceof Error ? error.message : undefined;
  }
  assert.ok(blockedReason, 'canonical negative oracle must give a specific reason');
  assert.ok(blockedReason.includes('unresolved dependencies'));
  assert.ok(blockedReason.includes(`#${String(before[0]!.displayId || before[0]!.id)} (pending)`));
  proof.exactBlockedReason = blockedReason;
  const hoverCard = async (id: string) => {
    // After a drag, the pointer can already be inside the reordered trigger.
    // Move to a non-tooltip control, then dismiss the focused HoverCard with Escape.
    const outside = record(
      await ui.waitRead(
        pointOf(`return document.querySelector('input[placeholder="Search tasks... (#id or text)"]');`),
        'original board control outside Task hover cards'
      )
    );
    await input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: outside.x, y: outside.y });
    step({ action: 'keyPress', key: 'Escape', label: 'dismiss original Task hover card once' });
    await input('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    });
    await input('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    });
    await ui.waitRead(
      `!document.querySelector('.kanban-task-card[data-state="open"]')`,
      'original Task hover cards closed after pointer leave and Escape'
    );
    const point = record(
      await ui.waitRead(
        pointOf(`return document.querySelector(${JSON.stringify(card(id))});`),
        'visible original card'
      )
    );
    await input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    const hovered = record(
      await ui.waitRead(
        `(() => {const e=document.querySelector(${JSON.stringify(card(id))});const open=[...document.querySelectorAll('.kanban-task-card[data-state="open"]')];return e&&open.length===1&&open[0]===e?{taskId:e.dataset.taskId,title:e.querySelector('h5')?.textContent.trim(),state:e.dataset.state}:null;})()`,
        'only the requested original Task hover toolbar is open'
      )
    );
    assert.equal(hovered.taskId, id);
    assert.equal(hovered.title, (await task(id)).subject);
    step({ observation: 'requested original Task hover toolbar', ...hovered });
  };
  const openToolbar =
    '.kanban-task-card-toolbar[data-state="open"] [data-kanban-task-toolbar="true"]';
  const dependentBytes = await readFile(join(taskDirectory, `${taskId}.json`), 'utf8');
  await hoverCard(taskId);
  await ui.click(
    `${openToolbar} button[aria-label="Start"]`,
    'ordinary blocked Start once'
  );
  proof.blockedStartReceipt = await receiptFor('task.start', taskId);
  assert.equal(record(proof.blockedStartReceipt).phase, 'rejected');
  assert.equal(await readFile(join(taskDirectory, `${taskId}.json`), 'utf8'), dependentBytes);
  proof.blockedStartScreenshot = await screenshot('ui-task-board-blocked-start.png');
  await hoverCard(options.seed.taskId);
  await ui.click(
    `${openToolbar} button[aria-label="Complete"]`,
    'complete original blocker once'
  );
  await waitProduct(
    () => task(options.seed.taskId),
    (row) => row.status === 'completed',
    'blocker completed through UI'
  );
  const comments = (await task(taskId)).comments;
  assert.ok(Array.isArray(comments));
  assert.equal(
    comments.filter((row) => record(row).id === `dep-resolved-${options.seed.taskId}-${taskId}`)
      .length,
    1
  );
  await hoverCard(taskId);
  await ui.click(
    `${openToolbar} button[aria-label="Start"]`,
    'same original Start after resolved dependency'
  );
  await waitProduct(
    () => task(taskId),
    (row) => row.status === 'in_progress',
    'same Task now starts'
  );
  const starts = (await commands()).filter(
    (row) =>
      record(row.command).operation === 'task.start' &&
      record(record(row.command).payload).taskId === taskId
  );
  assert.equal(starts.length, 2);
  assert.deepEqual(starts.map((row) => row.phase).sort(), ['completed', 'rejected']);
  const stableTasks = await rows(taskDirectory),
    stableCommands = await commands();
  const stableBoard = await readFile(join(teamDirectory, 'kanban-state.json'), 'utf8');
  const origin = await cdp.evaluate('performance.timeOrigin');
  options.assertOwnedRenderer();
  await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(
    `performance.timeOrigin!==${JSON.stringify(origin)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`,
    'fresh renderer document'
  );
  await ui.observeInput();
  if (!(await cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(card(taskId))}))`)))
    await ui.clickSidebar(subject);
  await ui.waitRead(
    `Boolean(document.querySelector(${JSON.stringify(card(taskId))}))`,
    'same task visible after reload'
  );
  assert.deepEqual(await rows(taskDirectory), stableTasks);
  assert.deepEqual(await commands(), stableCommands, 'reload/navigation never replays mutations');
  assert.equal(await readFile(join(teamDirectory, 'kanban-state.json'), 'utf8'), stableBoard);
  proof.reloadedScreenshot = await screenshot('ui-task-board-reloaded.png');
  await runDesktopTaskBoardAttachmentsUi(cdp, {
    root: options.root, taskId, subject, handleId: options.handleId, proof,
    assertOwnedRenderer: options.assertOwnedRenderer, step, task, commands, receiptFor, waitProduct, screenshot,
  });
  proof.tasks = await rows(taskDirectory);
  proof.receipts = await commands();
  proof.sourceHashes = await Promise.all(
    [
      'src/renderer/components/team/dialogs/CreateTaskDialog.tsx',
      'src/renderer/components/team/dialogs/TaskDetailDialog.tsx',
      'src/renderer/components/ui/MemberSelect.tsx',
      'src/renderer/components/team/dialogs/TaskAttachments.tsx',
      'src/renderer/components/team/dialogs/TaskCommentInput.tsx',
      'src/renderer/components/team/dialogs/TaskCommentsSection.tsx',
      'src/renderer/components/team/kanban/KanbanBoard.tsx',
      'src/renderer/components/team/kanban/KanbanTaskCard.tsx',
      'src/features/agent-backend/renderer/createHostTeamMutations.ts',
    ].map(async (path) => ({ path, sha256: await fileDigest(join(options.repo, path)) }))
  );
  proof.status = 'PASS';
  proof.visualReview = 'screenshots retained; independent visual inspection pending';
}
