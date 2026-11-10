import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { acquireProfileWriterLease } from '../../packages/legacy-agent-host/dist/adapters/profile/ProfileWriterLease.js';
import { createFilesystemTeamOwner } from '../../packages/legacy-agent-host/dist/adapters/team/createFilesystemTeamOwner.js';
import { teamCommandPath } from '../../packages/legacy-agent-host/dist/team/commandEntries.js';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';

import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';

const teamName = 'test-desktop-backend';
const commandId = 'TEST-large-accepted-task-comment';
const largeText = '漢'.repeat(200_000);
const textSha256 = createHash('sha256').update(largeText).digest('hex');

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Create one canonical oversized comment before any app/Host writer starts.
 * The existing human composer has a 50K limit; an offline stored comment from
 * the captured Owner may be larger. The 1 MiB RPC response is not used to seed.
 */
export async function prepareDesktopOversizedCommentUiFixture(
  root: string, seed: { taskId: string; subject: string }
): Promise<{ commandId: string; commentId: string; textBytes: number; textSha256: string }> {
  assert.equal(await realpath(root), root);
  assert.match(basename(root), /^TEST-desktop-backend-/);
  assert.ok(Buffer.byteLength(largeText) > 512 * 1024);
  const profile = JSON.parse(await readFile(join(root, 'host-profile.json'), 'utf8')) as TeamHostProfile;
  assert.equal(profile.owner.storageRoot, join(root, 'hoststore'));
  assert.equal(profile.principalId, 'TEST-human');
  assert.equal(profile.runtime, undefined);
  const selected = profile.teams.find(team => team.binding.teamName === teamName);
  assert.ok(selected, 'exact captured TEST team must exist');
  const lease = acquireProfileWriterLease(profile.owner.storageRoot);
  try {
    lease.assertCurrent();
    const owner = createFilesystemTeamOwner({
      root: profile.owner.storageRoot,
      binding: selected.binding,
      members: selected.members,
      grants: selected.grants,
      ...(selected.savedSettings ? { savedSettings: selected.savedSettings } : {}),
    });
    const connection = owner.connect(profile.principalId);
    const original = connection.listTasks().find(task => task.id === seed.taskId);
    assert.equal(original?.subject, seed.subject);
    const receipt = connection.execute({
      commandId,
      operation: 'task.comment',
      payload: { taskId: seed.taskId, text: largeText },
    });
    assert.equal(receipt.phase, 'completed', 'one authorized original Owner comment');
    const task = record(JSON.parse(await readFile(
      join(root, 'hoststore/tasks', teamName, seed.taskId + '.json'), 'utf8'
    )));
    const comments = task.comments;
    assert.ok(Array.isArray(comments));
    const matching = comments.map(record).filter(row => row.text === largeText);
    assert.equal(matching.length, 1, 'canonical large comment retained exactly once');
    const commentId = String(matching[0]!.id);
    assert.equal(receipt.effects.commentId, commentId);
    const proof = {
      commandId, commentId, textBytes: Buffer.byteLength(largeText), textSha256,
    };
    await writeFile(join(root, 'large-comment-seed-proof.json'), JSON.stringify(proof, null, 2), {
      mode: 0o600, flag: 'wx',
    });
    return proof;
  } finally {
    lease.release();
  }
}

/** Original authorized TEST Owner -> bounded signed Host pages -> cold Task UI.
 * No business mutation is retried or dispatched after app startup.
 */
export async function runDesktopOversizedCommentUiSmoke(
  cdp: UiCdpPort,
  options: {
    root: string;
    handleId: string;
    taskId: string;
    subject: string;
    assertOwnedRenderer(): void;
    step(value: Record<string, unknown>): void;
  }
): Promise<Record<string, unknown>> {
  assert.ok(Buffer.byteLength(largeText) > 512 * 1024);
  const ui = createDesktopUiControls(cdp, options);
  const taskPath = join(options.root, 'hoststore/tasks', teamName, options.taskId + '.json');
  const commandsDir = join(options.root, 'hoststore/teams', teamName, '.host-owner/commands');
  const commandPath = join(
    options.root, 'hoststore/teams', teamName, '.host-owner', teamCommandPath(commandId)
  );
  const seed = record(JSON.parse(await readFile(
    join(options.root, 'large-comment-seed-proof.json'), 'utf8'
  )));
  assert.equal(seed.commandId, commandId);
  assert.equal(seed.textBytes, Buffer.byteLength(largeText));
  assert.equal(seed.textSha256, textSha256);
  const originalReceipt = await readFile(commandPath, 'utf8');
  const receipt = record(JSON.parse(originalReceipt));
  assert.equal(receipt.phase, 'completed');
  assert.equal(record(receipt.command).operation, 'task.comment');
  assert.equal(record(record(receipt.command).payload).text, largeText);
  const originalTask = await readFile(taskPath, 'utf8');
  const saved = record(JSON.parse(originalTask));
  assert.equal(saved.subject, options.subject);
  assert.ok(Array.isArray(saved.comments));
  const matches = saved.comments.map(record).filter(row => row.text === largeText);
  assert.equal(matches.length, 1);
  const commentId = String(matches[0]!.id);
  assert.equal(commentId, seed.commentId);
  const commandNames = (await readdir(commandsDir)).sort();

  // The original Task detail (not a test-built component or alternate UI)
  // must recover every signed fragment after the captured Electron cold reload.
  const previousOrigin = await cdp.evaluate('performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(
    'performance.timeOrigin!==' + desktopJsLiteral(previousOrigin) +
      " && Boolean(window.electronAPI) && !document.getElementById('splash')",
    'cold original Task renderer'
  );
  await ui.observeInput();
  const card = '.kanban-task-card[data-task-id=' + desktopJsLiteral(options.taskId) + ']';
  if (!(await cdp.evaluate('Boolean(document.querySelector(' + desktopJsLiteral(card) + '))')))
    await ui.clickSidebar(options.subject);
  await ui.waitRead('Boolean(document.querySelector(' + desktopJsLiteral(card) + '))',
    'original Task card after cold readback');
  await ui.click(card + ' h5', 'open original Task detail after large comment');
  const commentSelector = '[role="dialog"] [data-task-comment-id=' +
    desktopJsLiteral(commentId) + ']';
  await ui.waitRead(
    'Boolean(document.querySelector(' + desktopJsLiteral(commentSelector) + '))',
    'original comment card after signed-page readback'
  );
  await ui.scrollTo(
    commentSelector + ' div.relative.flex.justify-center > button',
    'visible original long Task comment expander'
  );
  await ui.click(
    commentSelector + ' div.relative.flex.justify-center > button',
    'expand original long Task comment'
  );
  await ui.scrollTo(commentSelector + ' button', 'original Markdown Show all', 'Show all', 32);
  await ui.click(commentSelector + ' button', 'show every retained Unicode character', 'Show all');
  const visible = [
    '(() => {',
    "const node = [...document.querySelectorAll('[role=\"dialog\"] [data-task-comment-id]')]",
    '.find((el) => el.getAttribute("data-task-comment-id") === ' + desktopJsLiteral(commentId) + ');',
    "return node?.textContent?.includes('漢'.repeat(200000)) === true;",
    '})()',
  ].join('\n');
  await ui.waitRead(visible, 'complete Unicode in existing Task comment UI', 120_000);
  assert.equal(await readFile(taskPath, 'utf8'), originalTask, 'cold read cannot rewrite Task');
  assert.equal(await readFile(commandPath, 'utf8'), originalReceipt, 'cold read cannot replay command');
  assert.deepEqual((await readdir(commandsDir)).sort(), commandNames);

  options.assertOwnedRenderer();
  const capture = record(await cdp.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true,
  }));
  assert.equal(typeof capture.data, 'string');
  const imageBytes = Buffer.from(String(capture.data), 'base64');
  const screenshot = join(options.root, 'ui-task-large-comment-cold-readback.png');
  await writeFile(screenshot, imageBytes, { mode: 0o600, flag: 'wx' });
  // This real keyboard action dismisses the existing Task detail; following
  // F08 and Trash UI smokes must start with no modal blocking their controls.
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  });
  await ui.waitRead("!document.querySelector('[role=\"dialog\"]')",
    'original Task detail dismissed before following UI cases');
  const proof = {
    status: 'PASS',
    commandId,
    commentId,
    textBytes: Buffer.byteLength(largeText),
    textSha256,
    ownerSetupBeforeApp: true,
    originalTaskUiAfterColdReadback: true,
    screenshot: { path: screenshot, sha256: createHash('sha256').update(imageBytes).digest('hex') },
  };
  options.step({ observation: 'signed Host pages -> cold original Task UI', ...proof });
  return proof;
}
