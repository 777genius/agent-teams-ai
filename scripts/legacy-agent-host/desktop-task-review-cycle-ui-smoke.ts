import { hostTeamSelectionKey } from '../../src/features/agent-backend/contracts/teamSelection.ts';
import assert from 'node:assert/strict';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { digest } from '../../packages/legacy-agent-host/dist/team/identity.js';
import { fileDigest } from './desktop-backend-fixture.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { TeamCommand } from '@agent-teams/legacy-agent-host/team/contracts';
import type { runDesktopTaskBoardUiSmoke } from './desktop-task-board-ui-smoke.ts';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as unknown;
const teamName = 'test-desktop-backend';
const commentText = 'TEST review correction addressed in this product-only task cycle';

/** Original Task controls only. "Fix" is a UI comment; this does not claim a code edit or native work. */
export async function runDesktopTaskReviewCycleUiSmoke(
  cdp: UiCdpPort,
  options: Parameters<typeof runDesktopTaskBoardUiSmoke>[1]
) {
  assert.equal(await realpath(options.root), options.root);
  assert.match(basename(options.root), /^TEST-desktop-backend-/);
  const profile = record(await json(join(options.root, 'host-profile.json')));
  assert.equal(
    profile.runtime,
    undefined,
    'offline Task review proof must not allocate native providers'
  );
  const boardProof = record(options.evidence.taskBoardUiProof);
  assert.equal(boardProof.status, 'PASS');
  const createdReceipt = record(boardProof.createReceipt);
  const taskId = String(record(createdReceipt.effects).taskId);
  assert.match(taskId, /^[a-f0-9-]{36}$/);
  const directory = join(options.root, 'hoststore/teams', teamName),
    ownerDirectory = join(directory, '.host-owner');
  const taskPath = join(options.root, 'hoststore/tasks', teamName, taskId + '.json');
  const task = async () => record(await json(taskPath));
  const board = async () => record(await json(join(directory, 'kanban-state.json')));
  const commands = async () => {
    const path = join(ownerDirectory, 'commands');
    const files = (await readdir(path))
      .filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name))
      .sort();
    assert.ok(files.length <= 128);
    return Promise.all(files.map(async (name) => record(await json(join(path, name)))));
  };
  const inbox = async (member: string) => {
    assert.match(member, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
    try {
      const value = await json(join(directory, 'inboxes', member + '.json'));
      assert.ok(Array.isArray(value));
      assert.ok(value.length <= 256);
      return value.map(record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
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
      await new Promise<void>((done) => setTimeout(done, 100));
    }
    throw new Error(`Task review product outcome timed out: ${label}; no repeated mutation`);
  };
  const steps: Record<string, unknown>[] = [],
    proof: Record<string, unknown> = {
      status: 'INCOMPLETE',
      steps,
      taskId,
      scope:
        'Same original UI-created Task: Complete, Request review, Request Changes, Start, correction comment, Complete, Request review, Approve, canonical history/notifications and reload; original Disapprove returns approved Task to Done',
      excluded: [
        'native inference/execution',
        'code edits',
        'visible history widget qualification',
        'atomic multi-file publication',
        'crash/replay qualification',
        'Stage2',
      ],
      sourceSha256: await fileDigest(import.meta.filename),
    };
  options.evidence.taskReviewCycleUiProof = proof;
  const step = (row: Record<string, unknown>) =>
    steps.push({ monotonicMs: Math.round(performance.now()), ...row });
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step,
  });
  const card = `.kanban-task-card[data-task-id="${taskId}"]`;
  let previous = await task();
  assert.equal(previous.status, 'in_progress');
  assert.equal(previous.owner, 'alice');
  const original = structuredClone(previous),
    baselineCommands = await commands();
  const inboxFiles = (await readdir(join(directory, 'inboxes')))
    .filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name))
    .sort();
  assert.ok(inboxFiles.length <= 64);
  const baselineNotifications = (
    await Promise.all(
      inboxFiles.map(async (file) => {
        const member = file.slice(0, -5);
        return (await inbox(member)).map((message) => ({ member, message }));
      })
    )
  ).flat();
  const removedNotifications = new Set<string>();
  const notificationPayload = (message: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(message).filter(([key]) => key !== 'read' && key !== 'readAt')
    );
  const immutable = (row: Record<string, unknown>) => ({
    id: row.id,
    displayId: row.displayId,
    subject: row.subject,
    owner: row.owner,
    createdAt: row.createdAt,
    blockedBy: row.blockedBy,
  });
  const history = (row: Record<string, unknown>) => {
    const value = row.historyEvents ?? [];
    assert.ok(Array.isArray(value) && value.length <= 128);
    return value.map(record);
  };
  const receiptIds: string[] = [],
    notificationProofs: Record<string, unknown>[] = [],
    states: Record<string, unknown>[] = [];
  async function snapshotStage(
    receipt: Record<string, unknown>,
    expectedStatus: string,
    reviewState?: string,
    column?: 'review' | 'approved'
  ) {
    const command = record(receipt.command),
      payload = record(command.payload);
    assert.equal(payload.taskId, taskId);
    assert.equal(receipt.principalId, 'TEST-human');
    assert.equal(receipt.phase, 'completed');
    assert.equal(record(receipt.binding).teamName, teamName);
    const commandId = String(receipt.commandId);
    assert.match(commandId, /^[a-f0-9-]{36}$/);
    const plan = record(
      await json(join(ownerDirectory, 'task-plans', digest(commandId) + '.json'))
    );
    assert.equal(plan.commandId, commandId);
    assert.equal(plan.fingerprint, receipt.fingerprint);
    assert.ok(Array.isArray(plan.notifications) && plan.notifications.length <= 8);
    assert.ok(Array.isArray(plan.removedMessageIds) && plan.removedMessageIds.length <= 256);
    for (const id of plan.removedMessageIds) {
      assert.equal(typeof id, 'string');
      removedNotifications.add(id);
    }
    const settled = await waitProduct(
      async () => ({ task: await task(), board: await board() }),
      (value) => {
        const entries = record(value.board.tasks),
          entry = entries[taskId];
        return (
          value.task.status === expectedStatus &&
          (reviewState === undefined || value.task.reviewState === reviewState) &&
          (column === undefined
            ? entry === undefined
            : entry !== undefined && record(entry).column === column)
        );
      },
      String(command.operation)
    );
    assert.deepEqual(
      immutable(settled.task),
      immutable(original),
      'original Task identity/assignee/dependency remain'
    );
    const oldHistory = history(previous),
      nextHistory = history(settled.task);
    assert.deepEqual(
      nextHistory.slice(0, oldHistory.length),
      oldHistory,
      'each publication retains earlier Task history'
    );
    const oldComments = Array.isArray(previous.comments) ? previous.comments.map(record) : [];
    const nextComments = Array.isArray(settled.task.comments)
      ? settled.task.comments.map(record)
      : [];
    for (const before of oldComments)
      assert.deepEqual(
        nextComments.find((after) => after.id === before.id),
        before,
        'prior comments remain exact'
      );
    for (const raw of plan.notifications) {
      const notification = record(raw),
        member = String(notification.member),
        messageId = String(notification.messageId);
      const rows = await waitProduct(
        () => inbox(member),
        (rows) => rows.some((row) => row.messageId === messageId),
        'canonical planned notification'
      );
      const matches = rows.filter((row) => row.messageId === messageId);
      assert.equal(matches.length, 1);
      assert.equal(matches[0]!.text, notification.content);
      assert.equal(matches[0]!.source, 'system_notification');
      notificationProofs.push({
        commandId,
        member,
        messageId,
        text: notification.content,
        summary: matches[0]!.summary,
      });
    }
    if (command.operation === 'task.review' && payload.action === 'request')
      assert.equal(plan.notifications.length, 0, 'manual UI review has no configured reviewer');
    if (command.operation === 'task.review' && payload.action === 'request_changes')
      assert.ok(
        notificationProofs.some(
          (row) =>
            row.commandId === commandId &&
            row.member === 'alice' &&
            String(row.summary).startsWith('Fix request')
        )
      );
    if (command.operation === 'task.review' && payload.action === 'approve')
      assert.ok(
        notificationProofs.some(
          (row) =>
            row.commandId === commandId &&
            row.member === 'alice' &&
            String(row.summary).startsWith('Approved')
        )
      );
    previous = settled.task;
    receiptIds.push(commandId);
    states.push({
      commandId,
      command,
      status: settled.task.status,
      reviewState: settled.task.reviewState,
      history: nextHistory,
    });
    step({
      assertion:
        'original completed receipt and separate canonical product/notification reads settled',
      commandId,
      operation: command.operation,
      payload,
      status: expectedStatus,
    });
  }
  const newReceipt = async (
    before: Set<unknown>,
    operation: TeamCommand['operation'],
    action?: string
  ) => {
    const rows = await waitProduct(
      commands,
      (rows) =>
        rows.some((row) => {
          if (before.has(row.commandId) || row.family !== undefined) return false;
          const command = record(row.command),
            payload = record(command.payload);
          return (
            command.operation === operation &&
            payload.taskId === taskId &&
            (action === undefined || payload.action === action) &&
            ['completed', 'rejected'].includes(String(row.phase))
          );
        }),
      operation
    );
    const matches = rows.filter((row) => {
      if (before.has(row.commandId) || row.family !== undefined) return false;
      const command = record(row.command),
        payload = record(command.payload);
      return (
        command.operation === operation &&
        payload.taskId === taskId &&
        (action === undefined || payload.action === action)
      );
    });
    assert.equal(matches.length, 1, 'one original command per actual UI intent');
    return matches[0]!;
  };
  async function revealCard() {
    for (let attempt = 0; attempt < 12; attempt++) {
      const geometry = record(
        await ui.waitRead(
          `(() => {const e=document.querySelector(${desktopJsLiteral(card)});if(!e)return null;const r=e.getBoundingClientRect();let p=e.parentElement;while(p&&!(p.scrollWidth>p.clientWidth&&/auto|scroll/.test(getComputedStyle(p).overflowX)))p=p.parentElement;if(!p)return {visible:true};const b=p.getBoundingClientRect(),left=Math.max(0,b.left),right=Math.min(innerWidth,b.right),top=Math.max(0,b.top),bottom=Math.min(innerHeight,b.bottom);if(right<=left||bottom<=top)return null;return {visible:r.left>=left&&r.right<=right,x:(left+right)/2,y:(top+bottom)/2,deltaX:Math.max(-600,Math.min(600,r.x+r.width/2-(left+right)/2))};})()`,
          'original board horizontal viewport'
        )
      );
      if (geometry.visible === true) {
        await ui.scrollTo(card, 'original Task card viewport');
        return;
      }
      options.assertOwnedRenderer();
      step({ action: 'mouseWheel', label: 'reveal original Task column', ...geometry });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: geometry.x,
        y: geometry.y,
        deltaX: geometry.deltaX,
        deltaY: 0,
      });
      await new Promise<void>((done) => setTimeout(done, 100));
    }
    throw new Error('Original Task column cannot be revealed by bounded user scroll');
  }
  const openToolbar =
    '.kanban-task-card-toolbar[data-state="open"] [data-kanban-task-toolbar="true"]';
  const verifyHoveredCard = async () => {
    const hovered = record(
      await ui.waitRead(
        `(() => {const e=document.querySelector(${desktopJsLiteral(card)});const open=[...document.querySelectorAll('.kanban-task-card[data-state="open"]')];return e&&open.length===1&&open[0]===e?{taskId:e.dataset.taskId,title:e.querySelector('h5')?.textContent.trim(),state:e.dataset.state}:null;})()`,
        'only the original review Task hover toolbar is open'
      )
    );
    assert.equal(hovered.taskId, taskId);
    assert.equal(hovered.title, original.subject);
    step({ observation: 'requested original review Task hover toolbar', ...hovered });
  };
  async function toolbar(label: string, operation: TeamCommand['operation'], action?: string) {
    const before = new Set((await commands()).map((row) => row.commandId));
    await revealCard();
    const point = record(
      await ui.waitRead(
        `(() => {const e=document.querySelector(${desktopJsLiteral(card)});if(!e)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`,
        'original Task card'
      )
    );
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...point,
    });
    await verifyHoveredCard();
    await ui.click(
      `${openToolbar} button[aria-label="${label}"]`,
      'original ' + label + ' once'
    );
    return newReceipt(before, operation, action);
  }
  await ui.observeInput();
  await snapshotStage(await toolbar('Complete', 'task.lifecycle', 'complete'), 'completed');
  await snapshotStage(
    await toolbar('Request review', 'task.review', 'request'),
    'completed',
    'review',
    'review'
  );
  const changesBefore = new Set((await commands()).map((row) => row.commandId));
  await revealCard();
  const point = record(
    await ui.waitRead(
      `(() => {const e=document.querySelector(${desktopJsLiteral(card)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
      'original review card'
    )
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await verifyHoveredCard();
  await ui.click(
    `${openToolbar} button[aria-label="Request changes"]`,
    'open existing Request Changes dialog'
  );
  await ui.click('[role="dialog"] #review-comment', 'focus original changes comment');
  await cdp.send('Input.insertText', { text: 'TEST fix the review edge case' });
  await ui.click('[role="dialog"] button', 'original Request Changes Submit once', 'Submit');
  await ui.waitRead(
    '!document.querySelector(\'[role="dialog"] #review-comment\')',
    'Request Changes dialog closes'
  );
  await snapshotStage(
    await newReceipt(changesBefore, 'task.review', 'request_changes'),
    'pending',
    'needsFix'
  );
  await snapshotStage(await toolbar('Start', 'task.start'), 'in_progress');
  const commentBefore = new Set((await commands()).map((row) => row.commandId));
  await ui.click(card + ' h5', 'open original Task detail for correction comment');
  await ui.scrollTo(`[role="dialog"] #task-comment-${taskId}`, 'existing Task comment composer');
  await ui.click(`[role="dialog"] #task-comment-${taskId}`, 'focus existing correction comment');
  await cdp.send('Input.insertText', { text: commentText });
  await ui.click(
    '[role="dialog"] button.message-composer-send-button',
    'original correction Comment once',
    'Comment'
  );
  await snapshotStage(await newReceipt(commentBefore, 'task.comment'), 'in_progress');
  assert.equal(
    (previous.comments as unknown[]).map(record).filter((row) => row.text === commentText).length,
    1
  );
  await ui.click('[role="dialog"] button', 'close original corrected Task detail', 'Close');
  await snapshotStage(await toolbar('Complete', 'task.lifecycle', 'complete'), 'completed');
  await snapshotStage(
    await toolbar('Request review', 'task.review', 'request'),
    'completed',
    'review',
    'review'
  );
  await snapshotStage(
    await toolbar('Approve', 'task.review', 'approve'),
    'completed',
    'approved',
    'approved'
  );
  const reviewEvents = history(previous).filter((event) =>
    String(event.type).startsWith('review_')
  );
  assert.deepEqual(
    reviewEvents.map((event) => event.type),
    ['review_requested', 'review_changes_requested', 'review_requested', 'review_approved']
  );
  assert.ok(reviewEvents.every((event) => event.actor === 'user'));
  assert.equal(new Set(reviewEvents.map((event) => event.id)).size, reviewEvents.length);
  assert.equal(new Set(receiptIds).size, receiptIds.length);
  const frozenTask = await readFile(taskPath, 'utf8'),
    frozenBoard = await readFile(join(directory, 'kanban-state.json'), 'utf8'),
    frozenCommands = await commands();
  assert.equal(
    frozenCommands.length - baselineCommands.length,
    receiptIds.length,
    'all review-cycle mutations accounted for'
  );
  await revealCard();
  const screenshot = record(
    await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    })
  );
  const screenshotPath = join(options.root, 'ui-task-review-approved.png');
  await writeFile(screenshotPath, Buffer.from(String(screenshot.data), 'base64'), {
    mode: 0o600,
    flag: 'wx',
  });
  const origin = await cdp.evaluate('performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(
    `performance.timeOrigin!==${desktopJsLiteral(origin)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`,
    'new renderer after review cycle'
  );
  await ui.observeInput();
  await ui.clickSidebar(String(original.subject));
  await ui.waitRead(
    `Boolean(document.querySelector(${desktopJsLiteral(card)}))`,
    'same approved Task after reload'
  );
  assert.equal(await readFile(taskPath, 'utf8'), frozenTask);
  assert.equal(await readFile(join(directory, 'kanban-state.json'), 'utf8'), frozenBoard);
  assert.deepEqual(
    await commands(),
    frozenCommands,
    'reload/navigation creates no replacement review cycle'
  );
  for (const row of notificationProofs)
    if (!removedNotifications.has(String(row.messageId)))
      assert.equal(
        (await inbox(String(row.member))).filter((message) => message.messageId === row.messageId)
          .length,
        1
      );
  for (const before of baselineNotifications) {
    if (removedNotifications.has(String(before.message.messageId))) continue;
    const rows = (await inbox(before.member)).filter(
      (row) => row.messageId === before.message.messageId
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(notificationPayload(rows[0]!), notificationPayload(before.message));
  }
  const disapprove = await toolbar('Disapprove', 'task.review', 'disapprove');
  await snapshotStage(disapprove, 'completed', 'none');
  const disapprovedHistory = history(previous);
  assert.deepEqual(disapprovedHistory.slice(0, -1), history(JSON.parse(frozenTask) as Record<string, unknown>));
  assert.equal(disapprovedHistory.length, history(JSON.parse(frozenTask) as Record<string, unknown>).length + 1);
  assert.equal(disapprovedHistory.at(-1)!.type, 'review_disapproved');
  assert.equal(disapprovedHistory.at(-1)!.actor, 'user');
  assert.equal((await commands()).length - frozenCommands.length, 1, 'one original Disapprove command, no second lifecycle intent');
  await revealCard();
  const donePoint = record(await ui.waitRead(`(() => {const e=document.querySelector(${desktopJsLiteral(card)});if(!e)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`, 'original Disapproved Task card'));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...donePoint });
  await verifyHoveredCard();
  await ui.waitRead(`Boolean(document.querySelector(${desktopJsLiteral(openToolbar + ' button[aria-label="Request review"]')}))&&!document.querySelector(${desktopJsLiteral(openToolbar + ' button[aria-label="Disapprove"]')})`, 'same Task now exposes Done controls');
  proof.approvedToDone = { status: 'PASS', commandId: disapprove.commandId, statusAfter: 'completed', reviewStateAfter: 'none', doneControlsVisible: true };
  proof.removedNotificationIds = [...removedNotifications];
  proof.status = 'PASS';
  proof.receiptIds = receiptIds;
  proof.states = states;
  proof.notifications = notificationProofs;
  proof.screenshot = {
    path: screenshotPath,
    sha256: await fileDigest(screenshotPath),
  };
}

/** Existing notification navigation/delete only; no repeated Task review cycle. */
export async function runDesktopTaskNotificationUiSmoke(
  cdp: UiCdpPort,
  options: Parameters<typeof runDesktopTaskBoardUiSmoke>[1]
): Promise<void> {
  assert.equal(await realpath(options.root), options.root);
  assert.match(basename(options.root), /^TEST-desktop-backend-/);
  assert.equal(record(await json(join(options.root, 'host-profile.json'))).runtime, undefined);
  const boardProof = record(options.evidence.taskBoardUiProof);
  assert.equal(boardProof.status, 'PASS');
  const taskId = String(record(record(boardProof.createReceipt).effects).taskId);
  assert.match(taskId, /^[a-f0-9-]{36}$/);
  const taskPath = join(options.root, 'hoststore/tasks', teamName, taskId + '.json');
  const directory = join(options.root, 'hoststore/teams', teamName);
  const commandDirectory = join(directory, '.host-owner/commands');
  const commands = async () => {
    const names = (await readdir(commandDirectory)).filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name)).sort();
    assert.ok(names.length <= 128);
    return Promise.all(names.map(async (name) => record(await json(join(commandDirectory, name)))));
  };
  const frozenTask = await readFile(taskPath, 'utf8'),
    frozenBoard = await readFile(join(directory, 'kanban-state.json'), 'utf8'),
    frozenCommands = await commands();
  const steps: Record<string, unknown>[] = [], proof: Record<string, unknown> = {
    status: 'INCOMPLETE', taskId, steps, sourceSha256: await fileDigest(import.meta.filename),
    scope: 'Existing original Task-created notification hover View in session/Delete; conditional unread Mark as read',
    excluded: ['native OS notifications', 'review approve/request-changes from notification', 'native agents', 'Stage2'],
  };
  options.evidence.taskNotificationUiProof = proof;
  const ui = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer, step: (row) => { steps.push(row); } });
  const waitProduct = async <T>(read: () => Promise<T>, matches: (value: T) => boolean, label: string): Promise<T> => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      options.assertOwnedRenderer();
      const value = await read();
      if (matches(value)) return value;
      await new Promise<void>((done) => setTimeout(done, 100));
    }
    throw new Error(`Task notification outcome timed out: ${label}; no repeated mutation`);
  };
  // Read-only public lookup binds the existing UI row; effects remain trusted mouse input.
  const notifications = async () => {
    options.assertOwnedRenderer();
    const result = record(await cdp.evaluate('window.electronAPI.notifications.get({limit:100,offset:0})'));
    assert.equal(result.hasMore, false, 'bounded fresh TEST notification history');
    assert.ok(Array.isArray(result.notifications) && result.notifications.length <= 100);
    return result.notifications.map(record);
  };
  const rows = await waitProduct(notifications, (rows) => rows.some((row) => {
    const target = row.target === undefined ? undefined : record(row.target);
    return row.teamEventType === 'task_created' && target &&
      target.kind === 'task' && target.teamName === hostTeamSelectionKey(options.handleId) && target.taskId === taskId;
  }), 'original UI-created Task notification');
  const matches = rows.filter((row) => {
    const target = row.target === undefined ? undefined : record(row.target);
    return row.teamEventType === 'task_created' && target &&
      target.kind === 'task' && target.teamName === hostTeamSelectionKey(options.handleId) && target.taskId === taskId;
  });
  assert.equal(matches.length, 1);
  const notification = matches[0]!, notificationId = String(notification.id);
  assert.match(notificationId, /^[a-f0-9-]{36}$/);
  const message = String(notification.message), preview = message.length > 100 ? message.slice(0, 100) + '...' : message;
  const rowExpression = `[...document.querySelectorAll('[role="button"]')].filter(e=>e.querySelector('p')?.textContent===${desktopJsLiteral(preview)})`;
  const hoverNotification = async () => {
    await ui.click('button[aria-label="Notifications"]', 'existing Notifications tab');
    // Await the loaded view, not the identically named tab label or hidden pane scroll areas.
    const viewportExpression = `(() => {
      const viewports=new Set();
      for(const header of [...document.querySelectorAll('span')].filter(e=>e.textContent==='Notifications'&&!e.closest('[role="tab"]'))){
        for(let parent=header.parentElement;parent;parent=parent.parentElement){
          const viewport=[...parent.children].find(e=>e.matches('.overflow-y-auto'));
          if(!viewport)continue;const r=viewport.getBoundingClientRect();if(r.width>0&&r.height>0)viewports.add(viewport);break;
        }
      }
      if(viewports.size!==1)return null;const r=[...viewports][0].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`;
    // The list is virtualized. Only bounded wheel input; never DOM/store mutations.
    for (let page = 0; page < 12; page++) {
      const viewport = record(await ui.waitRead(viewportExpression, 'Notifications list viewport'));
      const point = await cdp.evaluate(`(() => {const rows=${rowExpression};if(rows.length>1)throw Error('ambiguous notification row');if(!rows.length)return null;const r=rows[0].getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`);
      if (point) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...record(point) });
        return;
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...viewport, deltaX: 0, deltaY: 400 });
      await new Promise<void>((done) => setTimeout(done, 100));
    }
    throw new Error('Original notification row unavailable; no action replay');
  };
  const notificationAction = async (title: string) => {
    const path = String(await ui.waitRead(`(() => {const rows=${rowExpression};if(rows.length!==1)return null;let e=rows[0].querySelector('button[title='+JSON.stringify(${desktopJsLiteral(title)})+']');if(!e)return null;const parts=[];while(e&&e!==document.documentElement){const p=e.parentElement;if(!p)return null;parts.unshift(e.tagName.toLowerCase()+':nth-child('+([...p.children].indexOf(e)+1)+')');e=p;}return 'html>'+parts.join('>');})()`, 'exact original notification action path'));
    await ui.click(path, 'original notification ' + title + ' once');
  };
  await hoverNotification();
  await ui.waitRead(`(() => {const rows=${rowExpression};return rows.length===1&&Boolean(rows[0].querySelector('button[title="View in session"]'));})()`, 'original notification hover menu rendered');
  const screenshot = record(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
  const screenshotPath = join(options.root, 'ui-task-notification-quick-actions.png');
  await writeFile(screenshotPath, Buffer.from(String(screenshot.data), 'base64'), { mode: 0o600, flag: 'wx' });
  proof.screenshot = { path: screenshotPath, sha256: await fileDigest(screenshotPath) };
  let markRead: string = 'unavailable: original viewed Team notification already read';
  if (notification.isRead === false) {
    await notificationAction('Mark as read');
    await waitProduct(notifications, (rows) => rows.find((row) => row.id === notificationId)?.isRead === true, 'original notification read');
    markRead = 'PASS';
    await hoverNotification();
  }
  await notificationAction('View in session');
  await ui.waitRead(`Boolean(document.querySelector('[role="dialog"] #task-comment-${taskId}'))`, 'notification opens original Task detail');
  await ui.click('[role="dialog"] button', 'close notification original Task detail', 'Close');
  await hoverNotification();
  const beforeDelete = await notifications();
  await notificationAction('Delete');
  const afterDelete = await waitProduct(notifications, (rows) => !rows.some((row) => row.id === notificationId), 'exact original notification deleted');
  for (const neighbor of beforeDelete.filter((row) => row.id !== notificationId))
    assert.deepEqual(afterDelete.find((row) => row.id === neighbor.id), neighbor, 'other original notifications remain');
  assert.equal(await readFile(taskPath, 'utf8'), frozenTask);
  assert.equal(await readFile(join(directory, 'kanban-state.json'), 'utf8'), frozenBoard);
  assert.deepEqual(await commands(), frozenCommands, 'notification actions never recreate or mutate the Task');
  Object.assign(proof, { status: 'PASS', notificationId, target: notification.target, navigate: 'PASS', delete: 'PASS', markRead });

}
