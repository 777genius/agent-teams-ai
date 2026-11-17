import { revealDesktopTaskReviewCard } from './desktop-task-review-card-readiness.ts';
import { desktopTaskCommentInputExpression } from './desktop-task-comment-input-target.ts';
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
    const entry = record((await board()).tasks)[taskId];
    await revealDesktopTaskReviewCard({
      cdp,
      ui,
      card,
      assertOwnedRenderer: options.assertOwnedRenderer,
      step,
      expected: {
        contextId: 'local',
        teamName: hostTeamSelectionKey(options.handleId),
        taskId,
        subject: original.subject,
        status: previous.status,
        reviewState: previous.reviewState ?? null,
        boardColumn: entry === undefined ? null : (record(entry).column ?? null),
      },
    });
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
    // This original portaled hover toolbar is already open; do not re-enter it via generic click hover.
    const selector = `${openToolbar} button[aria-label="${label}"]`;
    const target = record(
      await ui.waitRead(
        `(() => {const card=document.querySelector(${desktopJsLiteral(card)}),open=[...document.querySelectorAll('.kanban-task-card[data-state="open"]')];if(!card||open.length!==1||open[0]!==card||card.querySelector('h5')?.textContent.trim()!==${desktopJsLiteral(original.subject)})return null;const buttons=[...document.querySelectorAll(${desktopJsLiteral(selector)})].filter(e=>e.getClientRects().length);if(buttons.length!==1)return null;const e=buttons[0],r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return r.width>0&&r.height>0&&!e.disabled&&hit&&(hit===e||e.contains(hit))?{x,y,ariaLabel:e.getAttribute('aria-label')}:null;})()`,
        'exact original ' + label + ' toolbar button before one click'
      )
    );
    assert.equal(typeof target.x, 'number');
    assert.equal(typeof target.y, 'number');
    assert.equal(target.ariaLabel, label);
    options.assertOwnedRenderer();
    step({
      action: 'mouseClick',
      label: 'original ' + label + ' once',
      selector,
      target,
      state: 'attempted',
    });
    for (const type of ['mousePressed', 'mouseReleased']) {
      options.assertOwnedRenderer();
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x: target.x,
        y: target.y,
        button: 'left',
        clickCount: 1,
      });
    }
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
  await revealCard();
  await ui.click(card + ' h5', 'open original Task detail for correction comment');
  const commentTarget = record(
    await ui.waitRead(
      desktopTaskCommentInputExpression(options.handleId, taskId),
      'exact current correction Task/owner/surface',
      30_000,
      (value) =>
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).canEditNow === true
    )
  );
  assert.equal(typeof commentTarget.selector, 'string');
  await ui.scrollTo(String(commentTarget.selector), 'existing Task comment composer');
  await ui.click(String(commentTarget.selector), 'focus existing correction comment');
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
  assert.deepEqual(
    disapprovedHistory.slice(0, -1),
    history(JSON.parse(frozenTask) as Record<string, unknown>)
  );
  assert.equal(
    disapprovedHistory.length,
    history(JSON.parse(frozenTask) as Record<string, unknown>).length + 1
  );
  assert.equal(disapprovedHistory.at(-1)!.type, 'review_disapproved');
  assert.equal(disapprovedHistory.at(-1)!.actor, 'user');
  assert.equal(
    (await commands()).length - frozenCommands.length,
    1,
    'one original Disapprove command, no second lifecycle intent'
  );
  await revealCard();
  const donePoint = record(
    await ui.waitRead(
      `(() => {const e=document.querySelector(${desktopJsLiteral(card)});if(!e)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`,
      'original Disapproved Task card'
    )
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...donePoint });
  await verifyHoveredCard();
  await ui.waitRead(
    `Boolean(document.querySelector(${desktopJsLiteral(openToolbar + ' button[aria-label="Request review"]')}))&&!document.querySelector(${desktopJsLiteral(openToolbar + ' button[aria-label="Disapprove"]')})`,
    'same Task now exposes Done controls'
  );
  proof.approvedToDone = {
    status: 'PASS',
    commandId: disapprove.commandId,
    statusAfter: 'completed',
    reviewStateAfter: 'none',
    doneControlsVisible: true,
  };
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
