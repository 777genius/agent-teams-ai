import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';

import type { UiCdpPort } from './desktop-ui-controls.ts';

const largeText = '漢'.repeat(200_000);

/** Assert the captured TEST product value has the expected record shape. */
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Original TEST Host command -> signed pages -> cold existing Task UI. */
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
  const commandId = 'TEST-large-accepted-task-comment';
  const taskPath = join(options.root, 'hoststore/tasks/test-desktop-backend', options.taskId + '.json');
  /** Read the authoritative persisted task comment rows, never a UI approximation. */
  const readComments = async () => {
    const task = record(JSON.parse(await readFile(taskPath, 'utf8')));
    assert.ok(Array.isArray(task.comments));
    return (task.comments as unknown[]).map(record);
  };
  const before = await readComments();
  assert.equal(before.some((comment) => comment.text === largeText), false);

  // The normal composer caps human input at 50K characters. Here the
  // original TEST Host command creates a legitimate larger retained value;
  // only the existing cold renderer, not an alternate UI, is tested below.
  options.assertOwnedRenderer();
  const mutation = [
    '(async () => {',
    'const result = await window.electronAPI.agentBackend.invoke({',
    'handle: { handleId: ' + desktopJsLiteral(options.handleId) + ' },',
    'commandId: ' + desktopJsLiteral(commandId) + ',',
    "operation: 'task.comment',",
    'payload: {taskId: ' + desktopJsLiteral(options.taskId) + ", text: '漢'.repeat(200000) },",
    '});',
    'return {ok: result.ok, code: result.code ?? null, phase: result.value?.phase ?? null};',
    '})()',
  ].join('\n');
  const response = record(await cdp.evaluate(mutation));
  assert.equal(response.ok, true, 'Original TEST Host task.comment failed: ' + String(response.code));
  assert.equal(response.phase, 'completed');

  // Observe exactly one durable original comment. Never retry uncertain writes.
  let inserted: Record<string, unknown> | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    options.assertOwnedRenderer();
    const matches = (await readComments()).filter((comment) => comment.text === largeText);
    if (matches.length === 1) { inserted = matches[0]; break; }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(inserted, 'Large TEST Host comment not retained exactly once');
  assert.equal(typeof inserted.id, 'string');
  const commentId = inserted.id;
  assert.ok(!before.some((comment) => comment.id === commentId));

  // Cold reload must read all Owner pages and render the full Unicode string.
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
    'same original large comment card after signed-page readback'
  );
  // The unchanged MarkdownViewer intentionally previews the first 30K chars.
  // Expand its existing comment container, then use its real Show all control
  // before requiring the original full 600KB text in the rendered DOM.
  await ui.click(
    commentSelector + ' div.relative.flex.justify-center > button',
    'expand original long Task comment'
  );
  await ui.scrollTo(commentSelector + ' button', 'original Markdown Show all', 'Show all');
  await ui.click(commentSelector + ' button', 'show every retained Unicode character', 'Show all');
  const fullTextVisible = [
    '(() => {',
    "const node = [...document.querySelectorAll('[role=\"dialog\"] [data-task-comment-id]')]",
    '.find((el) => el.getAttribute("data-task-comment-id") === ' + desktopJsLiteral(commentId) + ');',
    "return node?.textContent?.includes('漢'.repeat(200000)) === true;",
    '})()',
  ].join('\n');
  await ui.waitRead(fullTextVisible, 'full Unicode in existing Task comment UI', 120_000);
  assert.equal((await readComments()).filter((comment) => comment.id === commentId).length, 1);

  options.assertOwnedRenderer();
  const captured = record(await cdp.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true,
  }));
  assert.equal(typeof captured.data, 'string');
  const screenshotBytes = Buffer.from(String(captured.data), 'base64');
  const screenshot = join(options.root, 'ui-task-large-comment-cold-readback.png');
  await writeFile(screenshot, screenshotBytes, { mode: 0o600, flag: 'wx' });
  const proof = {
    status: 'PASS',
    commandId,
    commentId,
    textBytes: Buffer.byteLength(largeText),
    textSha256: createHash('sha256').update(largeText).digest('hex'),
    originalTaskUiAfterColdReadback: true,
    screenshot: {
      path: screenshot,
      sha256: createHash('sha256').update(screenshotBytes).digest('hex'),
    },
  };
  options.step({ observation: 'real Host signed pages -> cold original Task UI', ...proof });
  return proof;
}
