import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { hostTeamSelectionKey } from '../../src/features/agent-backend/contracts/teamSelection.ts';
import { teamCommandPath, validateCommandEntry } from '../../packages/legacy-agent-host/dist/team/commandEntries.js';
import { fileDigest } from './desktop-backend-fixture.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { desktopTaskCommentInputExpression } from './desktop-task-comment-input-target.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { runDesktopTaskBoardUiSmoke } from './desktop-task-board-ui-smoke.ts';

type NotificationOptions = Parameters<typeof runDesktopTaskBoardUiSmoke>[1];
const teamName = 'test-desktop-backend';
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as unknown;

function isTaskNotification(row: Record<string, unknown>, handleId: string, taskId: string) {
  const target = row.target === undefined ? undefined : record(row.target);
  return row.teamEventType === 'task_created' && target?.kind === 'task' &&
    target.teamName === hostTeamSelectionKey(handleId) && target.taskId === taskId;
}

function notificationControls(
  cdp: UiCdpPort,
  options: NotificationOptions,
  steps: Record<string, unknown>[]
) {
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: (row) => {
      steps.push(row);
    },
  });
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
    throw new Error(`Task notification outcome timed out: ${label}; no repeated mutation`);
  };
  // Read-only public lookup binds the existing UI row; effects remain trusted mouse input.
  const notifications = async () => {
    options.assertOwnedRenderer();
    const result = record(
      await cdp.evaluate('window.electronAPI.notifications.get({limit:100,offset:0})')
    );
    assert.equal(result.hasMore, false, 'bounded fresh TEST notification history');
    assert.ok(Array.isArray(result.notifications) && result.notifications.length <= 100);
    return result.notifications.map(record);
  };
  const findTaskNotification = async (taskId: string, label: string) => {
    const rows = await waitProduct(
      notifications,
      (rows) => rows.some((row) => isTaskNotification(row, options.handleId, taskId)),
      label
    );
    const matches = rows.filter((row) => isTaskNotification(row, options.handleId, taskId));
    assert.equal(matches.length, 1);
    const notification = matches[0];
    assert.ok(notification);
    return { rows, notification };
  };
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
  const actions = (notification: Record<string, unknown>) => {
    const notificationId = String(notification.id);
    assert.match(notificationId, /^[a-f0-9-]{36}$/);
    const message = String(notification.message),
      preview = message.length > 100 ? message.slice(0, 100) + '...' : message;
    const rowExpression = `[...document.querySelectorAll('[role="button"]')].filter(e=>e.querySelector('p')?.textContent===${desktopJsLiteral(preview)})`;
    const hoverNotification = async () => {
      await ui.click('button[aria-label="Notifications"]', 'existing Notifications tab');
      // Await the loaded view, not the identically named tab label or hidden pane scroll areas.
      // The list is virtualized. Only bounded wheel input; never DOM/store mutations.
      for (let page = 0; page < 12; page++) {
        const viewport = record(await ui.waitRead(viewportExpression, 'Notifications list viewport'));
        const point = await cdp.evaluate(
          `(() => {const rows=${rowExpression};if(rows.length>1)throw Error('ambiguous notification row');if(!rows.length)return null;const r=rows[0].getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`
        );
        if (point) {
          steps.push({ action: 'mouseMove', label: 'original notification hover', notificationId, state: 'attempted' });
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...record(point) });
          return;
        }
        steps.push({ action: 'mouseWheel', label: 'original notification list', notificationId, page, state: 'attempted' });
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          ...viewport,
          deltaX: 0,
          deltaY: 400,
        });
        await new Promise<void>((done) => setTimeout(done, 100));
      }
      throw new Error('Original notification row unavailable; no action replay');
    };
    const notificationAction = async (title: string) => {
      const path = String(
        await ui.waitRead(
          `(() => {const rows=${rowExpression};if(rows.length!==1)return null;let e=rows[0].querySelector('button[title='+JSON.stringify(${desktopJsLiteral(title)})+']');if(!e)return null;const parts=[];while(e&&e!==document.documentElement){const p=e.parentElement;if(!p)return null;parts.unshift(e.tagName.toLowerCase()+':nth-child('+([...p.children].indexOf(e)+1)+')');e=p;}return 'html>'+parts.join('>');})()`,
          'exact original notification action path'
        )
      );
      await ui.click(path, 'original notification ' + title + ' once');
    };
    return { notificationId, rowExpression, hoverNotification, notificationAction };
  };
  const openNotifications = async () => {
    await ui.click('button[aria-label="Notifications"]', 'existing Notifications tab');
    await ui.waitRead(viewportExpression, 'Notifications list viewport');
  };
  return { ui, waitProduct, notifications, findTaskNotification, actions, openNotifications };
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
    const names = (await readdir(commandDirectory))
      .filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name))
      .sort();
    assert.ok(names.length <= 128);
    return Promise.all(names.map(async (name) => record(await json(join(commandDirectory, name)))));
  };
  const frozenTask = await readFile(taskPath, 'utf8'),
    frozenBoard = await readFile(join(directory, 'kanban-state.json'), 'utf8'),
    frozenCommands = await commands();
  const steps: Record<string, unknown>[] = [],
    proof: Record<string, unknown> = {
      status: 'INCOMPLETE',
      taskId,
      steps,
      sourceSha256: await fileDigest(import.meta.filename),
      scope:
        'Existing original Task-created notification hover View in session/Delete; conditional unread Mark as read',
      excluded: [
        'native OS notifications',
        'review approve/request-changes from notification',
        'native agents',
        'Stage2',
      ],
    };
  options.evidence.taskNotificationUiProof = proof;
  const { ui, waitProduct, notifications, findTaskNotification, actions } =
    notificationControls(cdp, options, steps);
  const { notification } = await findTaskNotification(
    taskId, 'original UI-created Task notification'
  );
  const { notificationId, rowExpression, hoverNotification, notificationAction } =
    actions(notification);
  await hoverNotification();
  await ui.waitRead(
    `(() => {const rows=${rowExpression};return rows.length===1&&Boolean(rows[0].querySelector('button[title="View in session"]'));})()`,
    'original notification hover menu rendered'
  );
  const screenshot = record(
    await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  );
  const screenshotPath = join(options.root, 'ui-task-notification-quick-actions.png');
  await writeFile(screenshotPath, Buffer.from(String(screenshot.data), 'base64'), {
    mode: 0o600,
    flag: 'wx',
  });
  proof.screenshot = { path: screenshotPath, sha256: await fileDigest(screenshotPath) };
  let markRead: string = 'unavailable: original viewed Team notification already read';
  if (notification.isRead === false) {
    await notificationAction('Mark as read');
    await waitProduct(
      notifications,
      (rows) => rows.find((row) => row.id === notificationId)?.isRead === true,
      'original notification read'
    );
    markRead = 'PASS';
    await hoverNotification();
  }
  await notificationAction('View in session');
  const selectedOwner = hostTeamSelectionKey(options.handleId);
  const navigationIdentity = record(
    await ui.waitRead(
      desktopTaskCommentInputExpression(options.handleId, taskId),
      'notification opens original Task detail at its exact captured owner'
    )
  );
  assert.equal(navigationIdentity.teamName, selectedOwner);
  assert.equal(navigationIdentity.taskId, taskId);
  proof.navigationIdentity = navigationIdentity;
  await ui.click('[role="dialog"] button', 'close notification original Task detail', 'Close');
  await hoverNotification();
  const beforeDelete = await notifications();
  await notificationAction('Delete');
  const afterDelete = await waitProduct(
    notifications,
    (rows) => !rows.some((row) => row.id === notificationId),
    'exact original notification deleted'
  );
  for (const neighbor of beforeDelete.filter((row) => row.id !== notificationId))
    assert.deepEqual(
      afterDelete.find((row) => row.id === neighbor.id),
      neighbor,
      'other original notifications remain'
    );
  assert.equal(await readFile(taskPath, 'utf8'), frozenTask);
  assert.equal(await readFile(join(directory, 'kanban-state.json'), 'utf8'), frozenBoard);
  assert.deepEqual(
    await commands(),
    frozenCommands,
    'notification actions never recreate or mutate the Task'
  );
  const runtimeSessions = await notificationRuntimeSessions(options.root);
  assert.deepEqual(
    runtimeSessions,
    [],
    'notification controls never allocate native Runtime sessions'
  );
  Object.assign(proof, {
    status: 'PASS',
    notificationId,
    target: notification.target,
    navigate: 'PASS',
    delete: 'PASS',
    markRead,
    runtimeSessions,
  });
}

interface CanonicalFileImage {
  name: string;
  bytes: string;
}

const byteDigest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const fileHashes = (files: CanonicalFileImage[]) =>
  files.map(({ name, bytes }) => ({ name, sha256: byteDigest(bytes) }));
const fileRecords = (files: CanonicalFileImage[]) =>
  files.map(({ bytes }) => record(JSON.parse(bytes) as unknown));

async function canonicalFiles(directory: string): Promise<CanonicalFileImage[]> {
  const names = (await readdir(directory))
    .filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name))
    .sort();
  assert.ok(names.length <= 128, 'bounded original TEST canonical inventory');
  return Promise.all(names.map(async (name) => ({
    name, bytes: await readFile(join(directory, name), 'utf8'),
  })));
}

function taskIdentities(files: CanonicalFileImage[]): string[] {
  return files.map(({ name, bytes }) => {
    const id = record(JSON.parse(bytes) as unknown).id;
    assert.ok(typeof id === 'string');
    assert.match(id, /^[a-f0-9-]{36}$/);
    assert.equal(name, id + '.json');
    return id;
  }).sort();
}

function createCommandIds(files: CanonicalFileImage[]): string[] {
  return fileRecords(files)
    .filter((row) => row.family === undefined && record(row.command).operation === 'task.create')
    .map((row) => String(row.commandId)).sort();
}

async function notificationRuntimeSessions(root: string) {
  return readDesktopNativeStopSessions(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' && error.path === join(root, 'hoststore/runtime-sessions'))
      return [];
    throw error;
  });
}

/** One explicit TEST create, then one real unread-to-read notification UI effect. */
export async function runDesktopTaskNotificationMarkReadUiSmoke(
  cdp: UiCdpPort,
  options: NotificationOptions
): Promise<void> {
  assert.equal(await realpath(options.root), options.root);
  assert.match(basename(options.root), /^TEST-desktop-backend-/);
  const profile = record(await json(join(options.root, 'host-profile.json')));
  assert.equal(record(profile.owner).storageRoot, join(options.root, 'hoststore'));
  assert.equal(profile.principalId, 'TEST-human');
  assert.equal(profile.runtime, undefined, 'notification setup stays on the offline Host');
  const boardProof = record(options.evidence.taskBoardUiProof);
  const originalProof = record(options.evidence.taskNotificationUiProof);
  assert.equal(boardProof.status, 'PASS');
  assert.equal(originalProof.status, 'PASS');
  assert.equal(record(options.evidence.taskTrashRestoreUiProof).status, 'PASS');
  const originalCreate = record(validateCommandEntry(
    boardProof.createReceipt as Parameters<typeof validateCommandEntry>[0]
  ));
  assert.equal(originalCreate.phase, 'completed');
  assert.equal(originalCreate.principalId, 'TEST-human');
  assert.equal(record(originalCreate.command).operation, 'task.create');
  const binding = record(originalCreate.binding);
  assert.equal(binding.teamName, teamName);
  assert.ok(typeof binding.backendId === 'string' && binding.backendId.length > 0);
  assert.ok(typeof binding.teamId === 'string' && binding.teamId.length > 0);
  const originalTaskId = String(record(originalCreate.effects).taskId);
  assert.equal(originalProof.taskId, originalTaskId);
  const originalTaskIds = [options.seed.taskId, originalTaskId].sort();
  assert.equal(new Set(originalTaskIds).size, 2);
  for (const id of originalTaskIds) assert.match(id, /^[a-f0-9-]{36}$/);
  const group = options.seed.group;
  assert.ok(group, 'preserve the original canonical group seed');
  assert.equal(record(boardProof.groupAssociation).status, 'PASS');
  const ownerSelectionKey = hostTeamSelectionKey(options.handleId);
  assert.equal(record(originalProof.target).teamName, ownerSelectionKey);
  const directory = join(options.root, 'hoststore/teams', teamName);
  const taskDirectory = join(options.root, 'hoststore/tasks', teamName);
  const commandDirectory = join(directory, '.host-owner/commands');
  const boardPath = join(directory, 'kanban-state.json');
  const steps: Record<string, unknown>[] = [];
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE',
    sourceSha256: await fileDigest(import.meta.filename),
    scope: 'One additional canonical TEST Task; original notification Mark as read false to true',
    originalTaskId,
    originalTaskIds,
    originalNotificationId: originalProof.notificationId,
    handleId: options.handleId,
    ownerSelectionKey,
    groupChatId: group.groupChatId,
    steps,
  };
  options.evidence.taskNotificationMarkReadUiProof = proof;
  const ui = notificationControls(cdp, options, steps);
  const beforeTasks = await canonicalFiles(taskDirectory);
  const beforeCommands = await canonicalFiles(commandDirectory);
  assert.deepEqual(taskIdentities(beforeTasks), originalTaskIds);
  const groupTasks = (files: CanonicalFileImage[]) => fileRecords(files)
    .filter((row) => row.groupChatId === group.groupChatId).map((row) => String(row.id)).sort();
  assert.deepEqual(groupTasks(beforeTasks), originalTaskIds);
  const beforeCreates = createCommandIds(beforeCommands);
  assert.equal(beforeCreates.length, 2);
  const runtimeSessionsBeforeSetup = await notificationRuntimeSessions(options.root);
  assert.deepEqual(runtimeSessionsBeforeSetup, []);
  Object.assign(proof, {
    taskHashesBeforeSetup: fileHashes(beforeTasks),
    commandHashesBeforeSetup: fileHashes(beforeCommands),
    taskIdsBeforeSetup: taskIdentities(beforeTasks),
    groupTaskIdsBeforeSetup: groupTasks(beforeTasks),
    createCommandIdsBeforeSetup: beforeCreates,
    runtimeSessionsBeforeSetup,
  });

  // Normal pane focus clears the viewed Team; actual unread state is still mandatory.
  await ui.openNotifications();
  const setupCommandId = 'TEST-notification-mark-read-' + randomUUID();
  const setupCommand = {
    commandId: setupCommandId,
    operation: 'task.create',
    payload: { subject: 'TEST unread notification ' + setupCommandId },
  };
  assert.ok(!fileRecords(beforeCommands).some((row) => row.commandId === setupCommandId));
  proof.setupCommand = setupCommand;
  steps.push({ fixtureAction: 'captured TEST owner notification Task setup', commandId: setupCommandId, state: 'attempted' });
  options.assertOwnedRenderer();
  const response = record(await cdp.evaluate(
    'window.electronAPI.agentBackend.invoke(' +
    desktopJsLiteral({ handle: { handleId: options.handleId }, ...setupCommand }) + ')'
  ));
  proof.setupResponse = response;
  assert.equal(response.ok, true);
  const publicReceipt = record(response.value);
  assert.equal(publicReceipt.commandId, setupCommandId);
  assert.equal(publicReceipt.operation, 'task.create');
  assert.equal(publicReceipt.phase, 'completed');
  assert.equal(publicReceipt.taskSubmissionNoEffect, undefined);
  assert.deepEqual(publicReceipt.taskSubmission, setupCommand);
  const taskId = record(publicReceipt.task).id;
  assert.ok(typeof taskId === 'string');
  assert.match(taskId, /^[a-f0-9-]{36}$/);
  assert.ok(!originalTaskIds.includes(taskId));
  const receiptName = basename(teamCommandPath(setupCommandId));
  const receiptBytes = await readFile(join(commandDirectory, receiptName), 'utf8');
  const setupReceipt = record(validateCommandEntry(
    JSON.parse(receiptBytes) as Parameters<typeof validateCommandEntry>[0]
  ));
  assert.equal(setupReceipt.family, undefined);
  assert.equal(setupReceipt.phase, 'completed');
  assert.equal(setupReceipt.principalId, 'TEST-human');
  assert.equal(setupReceipt.commandId, setupCommandId);
  assert.deepEqual(setupReceipt.binding, binding);
  assert.deepEqual(setupReceipt.command, setupCommand);
  assert.equal(record(setupReceipt.effects).taskId, taskId);
  assert.equal(record(setupReceipt.result).id, taskId);
  const afterTasks = await canonicalFiles(taskDirectory);
  const afterCommands = await canonicalFiles(commandDirectory);
  const finalTaskIds = [...originalTaskIds, taskId].sort();
  assert.deepEqual(taskIdentities(afterTasks), finalTaskIds);
  assert.deepEqual(
    afterTasks.filter((file) => originalTaskIds.includes(file.name.slice(0, -5))),
    beforeTasks, 'setup preserves both original Task byte images'
  );
  assert.equal(afterCommands.length, beforeCommands.length + 1);
  assert.deepEqual(afterCommands.filter((file) => file.name !== receiptName), beforeCommands);
  assert.deepEqual(afterCommands.find((file) => file.name === receiptName), { name: receiptName, bytes: receiptBytes });
  assert.deepEqual(createCommandIds(afterCommands), [...beforeCreates, setupCommandId].sort());
  assert.deepEqual(groupTasks(afterTasks), originalTaskIds);
  const created = fileRecords(afterTasks).find((row) => row.id === taskId);
  assert.ok(created);
  assert.equal(created.subject, setupCommand.payload.subject);
  assert.equal(created.status, 'pending');
  assert.equal(created.owner, undefined);
  assert.equal(created.groupChatId, undefined);
  for (const key of ['blockedBy', 'blocks', 'related']) assert.deepEqual(created[key] ?? [], []);
  Object.assign(proof, {
    taskId, setupReceipt, setupReceiptFile: receiptName,
    setupReceiptSha256: byteDigest(receiptBytes),
    taskIdsAfterSetup: taskIdentities(afterTasks),
    groupTaskIdsAfterSetup: groupTasks(afterTasks),
    createCommandIdsAfterSetup: createCommandIds(afterCommands),
  });
  steps.push({ fixtureAction: 'captured TEST owner notification Task setup', commandId: setupCommandId, taskId, state: 'completed' });

  const { rows: beforeNotifications, notification } = await ui.findTaskNotification(
    taskId, 'one new canonical TEST Task notification'
  );
  assert.equal(notification.isRead, false, 'a real unread notification is required');
  const actions = ui.actions(notification);
  assert.notEqual(actions.notificationId, originalProof.notificationId);
  const frozenBoard = await readFile(boardPath, 'utf8');
  Object.assign(proof, {
    notificationId: actions.notificationId,
    beforeNotification: notification,
    notificationIdsBeforeAction: beforeNotifications.map((row) => String(row.id)).sort(),
    neighborsBeforeAction: beforeNotifications.filter((row) => row.id !== actions.notificationId),
    taskHashesBeforeAction: fileHashes(afterTasks),
    commandHashesBeforeAction: fileHashes(afterCommands),
    boardSha256BeforeAction: byteDigest(frozenBoard),
  });
  await actions.hoverNotification();
  await actions.notificationAction('Mark as read');
  const afterNotifications = await ui.waitProduct(
    ui.notifications,
    (rows) => rows.find((row) => row.id === actions.notificationId)?.isRead === true,
    'same new notification read through its original UI control'
  );
  const afterNotification = afterNotifications.find((row) => row.id === actions.notificationId);
  assert.deepEqual(afterNotification, { ...notification, isRead: true });
  assert.deepEqual(
    afterNotifications.map((row) => String(row.id)).sort(),
    beforeNotifications.map((row) => String(row.id)).sort()
  );
  for (const neighbor of beforeNotifications.filter((row) => row.id !== actions.notificationId))
    assert.deepEqual(afterNotifications.find((row) => row.id === neighbor.id), neighbor);
  const finalTasks = await canonicalFiles(taskDirectory);
  const finalCommands = await canonicalFiles(commandDirectory);
  assert.deepEqual(finalTasks, afterTasks, 'Mark as read does not mutate any Task bytes');
  assert.deepEqual(finalCommands, afterCommands, 'Mark as read does not add or replay commands');
  assert.equal(await readFile(boardPath, 'utf8'), frozenBoard);
  assert.deepEqual(taskIdentities(finalTasks), finalTaskIds);
  const runtimeSessions = await notificationRuntimeSessions(options.root);
  assert.deepEqual(runtimeSessions, [], 'notification controls never allocate a native Runtime');
  assert.equal(steps.filter((step) => step.action === 'mouseClick' &&
    step.label === 'original notification Mark as read once' && step.state === 'attempted').length, 1);
  Object.assign(proof, {
    status: 'PASS',
    markRead: 'PASS',
    afterNotification,
    notificationIdsAfterAction: afterNotifications.map((row) => String(row.id)).sort(),
    neighborsAfterAction: afterNotifications.filter((row) => row.id !== actions.notificationId),
    taskIdsAfterAction: taskIdentities(finalTasks),
    taskHashesAfterAction: fileHashes(finalTasks),
    commandHashesAfterAction: fileHashes(finalCommands),
    boardSha256AfterAction: byteDigest(frozenBoard),
    runtimeSessions,
    retainedSetupTask: true,
  });
}
