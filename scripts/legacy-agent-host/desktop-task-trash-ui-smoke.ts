import assert from 'node:assert/strict';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { digest, fileDigest } from './desktop-backend-fixture.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import type { runDesktopTaskBoardUiSmoke } from './desktop-task-board-ui-smoke.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

const teamName = 'test-desktop-backend';
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const json = async (path: string) => record(JSON.parse(await readFile(path, 'utf8')));
const pause = () => new Promise<void>((done) => setTimeout(done, 100));

/** One original seeded Task, after the preceding workflows have finished their own censuses. */
export async function runDesktopTaskTrashRestoreUiSmoke(
  cdp: UiCdpPort,
  options: Parameters<typeof runDesktopTaskBoardUiSmoke>[1]
): Promise<void> {
  assert.equal(await realpath(options.root), options.root);
  assert.match(basename(options.root), /^TEST-desktop-backend-/);
  const profile = await json(join(options.root, 'host-profile.json'));
  assert.equal(profile.runtime, undefined, 'Task Trash remains on the original offline Host');
  assert.equal(record(options.evidence.taskBoardUiProof).status, 'PASS');
  if (options.evidence.f08ReadTimingProof)
    assert.equal(record(options.evidence.f08ReadTimingProof).status, 'PASS');
  const taskId = options.seed.taskId;
  const selection = 'host-team:' + encodeURIComponent(options.handleId);
  const taskPath = join(options.root, 'hoststore/tasks', teamName, taskId + '.json');
  const commandDirectory = join(options.root, 'hoststore/teams', teamName, '.host-owner/commands');
  const files = async (directory: string) => {
    let names: string[];
    try {
      names = (await readdir(directory))
        .filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    assert.ok(names.length <= 128, 'bounded original TEST file census');
    return Promise.all(
      names.map(async (name) => ({ name, bytes: await readFile(join(directory, name), 'utf8') }))
    );
  };
  const optionalBytes = async (path: string) => {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  assert.ok(Array.isArray(profile.teams) && profile.teams.length <= 16);
  const peerNames = profile.teams
    .map((value) => record(record(value).binding).teamName)
    .filter((name) => name !== teamName);
  assert.ok(peerNames.every((name) => typeof name === 'string' && /^[A-Za-z0-9_-]+$/.test(name)));
  const peers = () =>
    Promise.all(
      peerNames.map(async (name) => {
        const directory = join(options.root, 'hoststore/teams', String(name));
        return {
          teamName: name,
          tasks: await files(join(options.root, 'hoststore/tasks', String(name))),
          commands: await files(join(directory, '.host-owner/commands')),
          inboxes: await files(join(directory, 'inboxes')),
          config: await optionalBytes(join(directory, 'config.json')),
          board: await optionalBytes(join(directory, 'kanban-state.json')),
          owner: await optionalBytes(join(directory, '.host-owner/state.json')),
        };
      })
    );
  const beforeBytes = await readFile(taskPath, 'utf8');
  const before = record(JSON.parse(beforeBytes));
  assert.equal(before.id, taskId);
  assert.equal(before.subject, options.seed.subject);
  assert.equal(
    before.status,
    'completed',
    'reuse the original blocker completed by the board controls'
  );
  assert.equal(taskId, taskId.trim());
  assert.match(
    taskId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
  const displayId = before.displayId;
  assert.ok(typeof displayId === 'string' && displayId.trim());
  const displayLabel = '#' + displayId.trim();
  const priorCommands = await files(commandDirectory),
    peerBefore = await peers();
  assert.ok(priorCommands.length > 0, 'retain the preceding original command census');
  const beforeTasks = await files(join(options.root, 'hoststore/tasks', teamName));
  const deletedCount = beforeTasks.filter(
    (file) => record(JSON.parse(file.bytes)).status === 'deleted'
  ).length;
  const steps: Record<string, unknown>[] = [];
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE',
    taskId,
    displayLabel,
    steps,
    before,
    scope:
      'Original seeded Task Delete hover control, themed confirmation, count-only Task Trash, exact subject/display-ID row and original Restore task; canonical restore returns pending',
    excluded: ['native providers', 'global Trash UI', 'crash/replay qualification', 'full Stage1'],
    priorCommands: priorCommands.map((file) => ({ name: file.name, sha256: digest(file.bytes) })),
    peersBefore: peerBefore,
    sourceSha256: await fileDigest(import.meta.filename),
  };
  options.evidence.taskTrashRestoreUiProof = proof;
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: (value) => steps.push({ monotonicMs: Math.round(performance.now()), ...value }),
  });
  const currentCommands = async (addedCount: number) => {
    const current = await files(commandDirectory);
    for (const original of priorCommands)
      assert.equal(
        current.find((file) => file.name === original.name)?.bytes,
        original.bytes,
        'every preceding workflow receipt remains byte-for-byte unchanged'
      );
    const added = current.filter(
      (file) => !priorCommands.some((original) => original.name === file.name)
    );
    assert.ok(added.length <= addedCount, 'no additional mutation or replacement command');
    return added;
  };
  const waitStage = async (action: 'delete' | 'restore', status: string, count: number) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      options.assertOwnedRenderer();
      const added = await currentCommands(count);
      const receipts = added.map((file) => record(JSON.parse(file.bytes)));
      const matches = receipts.filter((receipt) => {
        const command = record(receipt.command),
          payload = record(command.payload);
        return (
          command.operation === 'task.lifecycle' &&
          payload.taskId === taskId &&
          payload.action === action
        );
      });
      assert.ok(matches.length <= 1, 'one original intent for this Task control');
      const task = await json(taskPath),
        receipt = matches[0];
      if (added.length === count && receipt?.phase === 'completed' && task.status === status) {
        assert.equal(receipt.principalId, 'TEST-human');
        assert.equal(record(receipt.binding).teamName, teamName);
        assert.deepEqual(record(record(receipt.command).payload), { taskId, action });
        assert.deepEqual(
          receipt.result,
          task,
          'actual completed receipt names the exact canonical Task state'
        );
        return { task, receipt, files: added };
      }
      await pause();
    }
    throw new Error(`Task Trash outcome timed out: ${action}; no mutation retry`);
  };
  const card = `[data-section-id="kanban"] .kanban-task-card[data-task-id=${desktopJsLiteral(taskId)}]`;
  const expectedCard = `(() => {const e=document.querySelector(${desktopJsLiteral(card)});return e&&e.querySelector('h5')?.textContent.trim()===${desktopJsLiteral(before.subject)}&&[...e.querySelectorAll('span')].some(span=>span.textContent.trim()===${desktopJsLiteral(displayLabel)});})()`;
  const immutable = (task: Record<string, unknown>) =>
    Object.fromEntries(
      [
        'id',
        'displayId',
        'subject',
        'description',
        'owner',
        'createdAt',
        'blocks',
        'blockedBy',
        'related',
        'groupChatId',
        'prompt',
        'promptTaskRefs',
        'descriptionTaskRefs',
        'attachments',
        'comments',
      ].map((key) => [key, task[key]])
    );
  await ui.clickSidebar(options.seed.subject);
  await ui.waitRead(
    `(() => {const s=window.__agentTeamsDevStore?.getState();return s?.selectedTeamName===${desktopJsLiteral(selection)}&&s.selectedTeamData?.teamName===${desktopJsLiteral(selection)}&&!s.selectedTeamLoading;})()`,
    'original Task source selected for Trash'
  );
  const boardSearch =
    '[data-section-id="kanban"] input[placeholder="Search tasks... (#id or text)"]';
  await ui.scrollTo(boardSearch, 'original board search before closing Task hover toolbars');
  await ui.click(boardSearch, 'focus original board outside the Task hover toolbar');
  options.assertOwnedRenderer();
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await ui.waitRead(
    `!document.querySelector('.kanban-task-card[data-state="open"]')`,
    'original Task hover cards closed before the seeded target'
  );
  await ui.scrollTo(card, 'original seeded Task card before Delete');
  await ui.waitRead(expectedCard, 'exact original Task subject and display ID before Delete');
  const point = record(
    await ui.waitRead(
      `(() => {const e=document.querySelector(${desktopJsLiteral(card)});if(!e)return null;const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return r.width&&r.height&&hit&&(hit===e||e.contains(hit))?{x,y}:null;})()`,
      'visible original seeded Task hover target'
    )
  );
  options.assertOwnedRenderer();
  steps.push({ action: 'mouseMoved', label: 'hover only the original seeded Task', taskId, point });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await ui.waitRead(
    `(() => {const e=document.querySelector(${desktopJsLiteral(card)}),open=[...document.querySelectorAll('.kanban-task-card[data-state="open"]')];return open.length===1&&open[0]===e;})()`,
    'only the original seeded Task hover toolbar is open'
  );
  await ui.click(
    '.kanban-task-card-toolbar[data-state="open"] [data-kanban-task-toolbar="true"] button[aria-label="Delete task"]',
    'original Task Delete control once'
  );
  const confirm = '[role="dialog"][aria-label="Delete task"]';
  await ui.waitRead(
    `(() => {const e=document.querySelector(${desktopJsLiteral(confirm)});return e&&e.querySelector('p')?.textContent.trim()===${desktopJsLiteral('Move task #' + taskId.slice(0, 8).toLowerCase() + ' to trash?')};})()`,
    'original themed confirmation identifies the same canonical Task'
  );
  assert.equal(
    await readFile(taskPath, 'utf8'),
    beforeBytes,
    'opening confirmation alone cannot delete the Task'
  );
  assert.equal((await currentCommands(0)).length, 0);
  await ui.click(
    confirm + ' button[data-confirm-btn]',
    'confirm original Task Delete once',
    'Delete'
  );
  const deleted = await waitStage('delete', 'deleted', 1);
  proof.deleted = deleted.task;
  proof.deleteReceipt = deleted.receipt;
  proof.deletedSha256 = await fileDigest(taskPath);
  assert.deepEqual(immutable(deleted.task), immutable(before));
  assert.equal(typeof deleted.task.deletedAt, 'string');
  await ui.waitRead(
    `!document.querySelector(${desktopJsLiteral(card)})`,
    'deleted original Task leaves the active board'
  );
  const trash =
    '[data-section-id="kanban"] button:has(svg.lucide-trash2), [data-section-id="kanban"] button:has(svg.lucide-trash-2)';
  await ui.scrollTo(trash, 'original count-only Task Trash control', String(deletedCount + 1));
  await ui.click(trash, 'open original count-only Task Trash once', String(deletedCount + 1));
  const rowExpression = `(() => {const dialogs=[...document.querySelectorAll('[role="dialog"]')].filter(e=>e.querySelector('h2')?.textContent.trim()==='Trash');if(dialogs.length!==1)return null;const rows=[...dialogs[0].querySelectorAll('tbody tr')].filter(row=>row.cells[0]?.textContent.trim()===${desktopJsLiteral(displayLabel)}&&row.cells[1]?.textContent.trim()===${desktopJsLiteral(before.subject)});if(rows.length!==1)return null;const row=rows[0],buttons=[...row.querySelectorAll('button[aria-label="Restore task"]')];if(buttons.length!==1||buttons[0].disabled)return null;const e=buttons[0],r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return r.width&&r.height&&hit&&(hit===e||e.contains(hit))?{x,y,displayId:row.cells[0].textContent.trim(),subject:row.cells[1].textContent.trim(),owner:row.cells[2].textContent.trim()}:null;})()`;
  proof.trashRow = await ui.waitRead(
    rowExpression,
    'exact original subject/display-ID Trash row and its Restore task control'
  );
  options.assertOwnedRenderer();
  const deletedScreenshot = record(
    await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  );
  assert.equal(typeof deletedScreenshot.data, 'string');
  const deletedScreenshotPath = join(options.root, 'ui-task-trash-original-row.png');
  await writeFile(deletedScreenshotPath, Buffer.from(String(deletedScreenshot.data), 'base64'), {
    mode: 0o600,
    flag: 'wx',
  });
  proof.deletedScreenshot = {
    path: deletedScreenshotPath,
    sha256: await fileDigest(deletedScreenshotPath),
  };
  const restoreHover = record(
    await ui.waitRead(rowExpression, 'original exact-row Restore task hover target')
  );
  options.assertOwnedRenderer();
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: restoreHover.x,
    y: restoreHover.y,
  });
  const restorePoint = record(
    await ui.waitRead(
      rowExpression,
      'original Restore task target immediately before its one click'
    )
  );
  options.assertOwnedRenderer();
  steps.push({
    action: 'mouseClick',
    label: 'original exact-row Restore task once',
    taskId,
    target: restorePoint,
    state: 'attempted',
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: restorePoint.x,
    y: restorePoint.y,
    button: 'left',
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: restorePoint.x,
    y: restorePoint.y,
    button: 'left',
    clickCount: 1,
  });
  const restored = await waitStage('restore', 'pending', 2);
  proof.restored = restored.task;
  proof.restoreReceipt = restored.receipt;
  assert.deepEqual(immutable(restored.task), immutable(before));
  assert.equal(restored.task.deletedAt, undefined);
  assert.equal(restored.task.reviewState, 'none');
  assert.equal(
    restored.files.find((file) => file.name === deleted.files[0]!.name)?.bytes,
    deleted.files[0]!.bytes,
    'the original completed Delete receipt remains unchanged after Restore'
  );
  await ui.waitRead(
    `(() => {const dialog=[...document.querySelectorAll('[role="dialog"]')].find(e=>e.querySelector('h2')?.textContent.trim()==='Trash');return dialog&&![...dialog.querySelectorAll('tbody tr')].some(row=>row.cells[0]?.textContent.trim()===${desktopJsLiteral(displayLabel)}&&row.cells[1]?.textContent.trim()===${desktopJsLiteral(before.subject)});})()`,
    'restored original Task leaves the visible Trash rows'
  );
  await ui.click('[role="dialog"] > button', 'close original Task Trash dialog', 'Close');
  await ui.waitRead(
    `(${expectedCard})&&window.__agentTeamsDevStore?.getState().selectedTeamData?.tasks.find(task=>task.id===${desktopJsLiteral(taskId)})?.status==='pending'`,
    'same original Task returns to the active board as pending'
  );
  await ui.waitRead(
    `(() => {const counts=[...document.querySelectorAll(${desktopJsLiteral(trash)})].map(button=>button.textContent.trim()).filter(text=>/^\\d+$/.test(text));return ${deletedCount}===0?counts.length===0:counts.length===1&&counts[0]===${desktopJsLiteral(String(deletedCount))};})()`,
    'original Task Trash count returns to its preceding value'
  );
  const finalCommands = await currentCommands(2);
  assert.equal(finalCommands.length, 2, 'only original Delete and Restore add mutation receipts');
  assert.deepEqual(
    await peers(),
    peerBefore,
    'peer Task/receipt/inbox/config/board/owner bytes stay unchanged'
  );
  proof.finalCommands = finalCommands.map((file) => ({
    name: file.name,
    sha256: digest(file.bytes),
  }));
  proof.beforeSha256 = digest(beforeBytes);
  proof.restoredSha256 = await fileDigest(taskPath);
  proof.peerTeamsUnchanged = peerNames;
  proof.status = 'PASS';
}
