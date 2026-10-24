import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
const rows = (value: unknown): Row[] => {
  assert.ok(Array.isArray(value));
  return value.map(row);
};
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type WaitProduct = <T>(read: () => Promise<T>, matches: (value: T) => boolean, label: string) => Promise<T>;

/** Extension of the existing offline task-board flow; original file/comment controls only. */
export async function runDesktopTaskBoardAttachmentsUi(cdp: UiCdpPort, options: {
  root: string; taskId: string; subject: string; handleId: string; proof: Row;
  assertOwnedRenderer(): void; step(value: Row): void;
  task(id: string): Promise<Row>; commands(): Promise<Row[]>;
  receiptFor(operation: string, taskId: string, predicate?: (payload: Row) => boolean): Promise<Row>;
  waitProduct: WaitProduct;
  screenshot(name: string): Promise<{ path: string; sha256: string }>;
}) {
  assert.equal(await realpath(options.root), options.root);
  const proof: Row = { status: 'INCOMPLETE', scope: 'Existing Task image upload/preview, comment text-file upload/download, reload and Task image remove; offline canonical owner',
    limits: { taskImageBytes: 20 * 1024 * 1024, commentFileBytes: 20 * 1024 * 1024, commentBatchBytes: 100 * 1024 * 1024, commentFiles: 5 },
    excluded: ['boundary-size qualification', 'native image delivery', 'chat attachments', 'native picker', 'cold app restart', 'blob garbage collection'] };
  options.proof.attachments = proof;
  proof.sourceSha256 = sha(await readFile(import.meta.filename));
  const ui = createDesktopUiControls(cdp, options);
  const directory = join(options.root, 'task-board-attachment-inputs');
  await mkdir(directory, { mode: 0o700 });
  assert.equal(await realpath(directory), directory);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=', 'base64');
  const text = Buffer.from('TEST canonical task comment attachment\n');
  const imageName = 'TEST-task-owned.png', textName = 'TEST-comment-owned.txt';
  for (const [name, bytes] of [[imageName, png], [textName, text]] as const)
    await writeFile(join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
  proof.fixtureFiles = [{ filename: imageName, size: png.length, sha256: sha(png) }, { filename: textName, size: text.length, sha256: sha(text) }];
  const card = `.kanban-task-card[data-task-id=${JSON.stringify(options.taskId)}] h5`;
  const commentInput = `[role="dialog"] textarea[id=${JSON.stringify('task-comment-' + options.taskId)}]`;
  const openDetail = async () => {
    if (!(await cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(commentInput)}))`))) {
      assert.equal(await cdp.evaluate(`Boolean(document.querySelector('[role="dialog"]'))`), false);
      await ui.scrollTo(card, 'same canonical Task subject');
      await ui.click(card, 'open same Task detail once');
    }
    await ui.waitRead(`Boolean(document.querySelector(${JSON.stringify(commentInput)}))`, 'exact original Task comment input');
  };
  const imageSelector = `[role="dialog"] img[alt=${JSON.stringify(imageName)}]`;
  const imageLoaded = () => ui.waitRead(`(() => {const e=document.querySelector(${JSON.stringify(imageSelector)});return e?.complete&&e.naturalWidth===2&&e.naturalHeight===1?{src:e.currentSrc||e.src,width:e.naturalWidth,height:e.naturalHeight}:null;})()`, 'original Task PNG decoded');
  const verifyImage = async () => {
    await ui.scrollTo(imageSelector, 'original Task image thumbnail');
    const loaded = row(await imageLoaded());
    assert.match(String(loaded.src), /^data:image\/png;base64,/);
    assert.equal(sha(Buffer.from(String(loaded.src).split(',')[1]!, 'base64')), sha(png));
    return { sha256: sha(png), width: loaded.width, height: loaded.height };
  };
  const setOriginalFileInput = async (selector: string, path: string) => {
    assert.equal(await realpath(path), path);
    assert.equal(path.startsWith(directory + '/'), true);
    options.assertOwnedRenderer();
    const document = row(await cdp.send('DOM.getDocument', { depth: 0 }));
    const found = row(await cdp.send('DOM.querySelectorAll', { nodeId: row(document.root).nodeId, selector }));
    assert.ok(Array.isArray(found.nodeIds) && found.nodeIds.length === 1, 'one original file input');
    options.step({ action: 'DOM.setFileInputFiles', selector, filename: path.split('/').at(-1), state: 'attempted', nativePicker: false });
    options.assertOwnedRenderer();
    await cdp.send('DOM.setFileInputFiles', { nodeId: found.nodeIds[0], files: [path] });
  };
  const readAttachment = async (id: string, expected: Buffer): Promise<Row | null> => {
    options.assertOwnedRenderer();
    const result = row(await cdp.evaluate(`window.electronAPI.agentBackend.invoke(${JSON.stringify({ handle: { handleId: options.handleId }, commandId: randomUUID(), operation: 'task.attachment.read', payload: { taskId: options.taskId, attachmentId: id, offset: 0 } })})`));
    assert.equal(result.ok, true, 'actual read-only captured Host attachment result');
    if (result.value === null) return null;
    const value = row(result.value), metadata = row(value.attachment);
    assert.equal(metadata.id, id);
    assert.equal(metadata.filePath, undefined);
    assert.equal(metadata.artifactId, undefined);
    assert.equal(metadata.size, expected.length);
    assert.equal(value.offset, 0); assert.equal(value.nextOffset, null);
    assert.equal(value.sha256, sha(expected));
    assert.deepEqual(Buffer.from(String(value.base64), 'base64'), expected);
    return { attachment: metadata, sha256: value.sha256, size: expected.length };
  };
  const reference = (receipt: Row, metadata: Row, expected: Buffer, comment = false) => {
    assert.equal(receipt.phase, 'completed');
    const payload = row(row(receipt.command).payload);
    const ref = comment ? rows(payload.attachments)[0]! : row(payload.attachment);
    if (comment) assert.equal(rows(payload.attachments).length, 1);
    assert.match(String(ref.artifactId), /^[a-f0-9]{64}$/);
    assert.equal(ref.artifactId, metadata.artifactId);
    assert.equal(ref.byteLength, expected.length); assert.equal(ref.digest, sha(expected));
    assert.equal(ref.mimeType, metadata.mimeType);
    assert.equal(ref.filePath, undefined); assert.equal(ref.base64Data, undefined);
    return ref;
  };

  await openDetail();
  const imageInput = '[role="dialog"] input[type="file"][accept="image/png,image/jpeg,image/gif,image/webp"]';
  if (!(await cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(imageInput)}))`))) {
    // Derive a unique selector from the existing section header; never create a control.
    const header = await ui.waitRead(`(() => {const d=document.querySelector('[role="dialog"]');const sections=[...d.querySelectorAll('section')].filter(s=>[...s.querySelectorAll(':scope > div span')].some(e=>e.textContent.trim()==='Attachments'));if(sections.length!==1)return null;let e=sections[0].querySelector('button[aria-label="Expand section"]');if(!e)return null;const path=[];while(e!==d){path.unshift(e.localName+':nth-child('+([...e.parentElement.children].indexOf(e)+1)+')');e=e.parentElement;}return '[role="dialog"] > '+path.join(' > ');})()`, 'existing collapsed Attachments section');
    assert.equal(typeof header, 'string');
    await ui.scrollTo(String(header), 'original Attachments section header');
    await ui.click(String(header), 'expand original Attachments once');
  }
  await setOriginalFileInput(imageInput, join(directory, imageName));
  const addedTask = await options.waitProduct(() => options.task(options.taskId), value => rows(value.attachments ?? []).some(item => item.filename === imageName), 'one canonical Task image');
  const images = rows(addedTask.attachments).filter(item => item.filename === imageName);
  assert.equal(images.length, 1);
  const image = images[0]!;
  const addReceipt = await options.receiptFor('task.attachment.add', options.taskId);
  proof.imageReference = reference(addReceipt, image, png);
  proof.addReceipt = addReceipt;
  proof.imageBeforeReload = await verifyImage();
  proof.addedScreenshot = await options.screenshot('ui-task-board-attachment-added.png');

  await ui.scrollTo(commentInput, 'original Task comment Composer');
  await ui.click(commentInput, 'focus original Task comment');
  options.assertOwnedRenderer();
  await cdp.send('Input.insertText', { text: 'TEST attachment comment original' });
  await setOriginalFileInput('[role="dialog"] input[type="file"][accept="*/*"]', join(directory, textName));
  await ui.waitRead(`document.querySelector('[role="dialog"]')?.textContent.includes(${JSON.stringify(textName)})`, 'original pending comment file preview');
  await ui.scrollTo('[role="dialog"] button', 'original Comment submit', 'Comment');
  await ui.click('[role="dialog"] button', 'submit original comment and file once', 'Comment');
  const commentedTask = await options.waitProduct(() => options.task(options.taskId), value => rows(value.comments ?? []).some(item => item.text === 'TEST attachment comment original'), 'canonical comment with attachment');
  const comments = rows(commentedTask.comments).filter(item => item.text === 'TEST attachment comment original');
  assert.equal(comments.length, 1);
  const comment = comments[0]!, files = rows(comment.attachments);
  assert.equal(files.length, 1); assert.equal(files[0]!.filename, textName);
  const commentReceipt = await options.receiptFor('task.comment', options.taskId, payload => payload.text === comment.text);
  proof.commentReference = reference(commentReceipt, files[0]!, text, true);
  proof.commentReceipt = commentReceipt;
  const retainedCommands = await options.commands();
  const origin = await cdp.evaluate('performance.timeOrigin');
  options.assertOwnedRenderer();
  options.step({ action: 'Page.reload', state: 'attempted', scope: 'renderer reload only' });
  await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(`performance.timeOrigin!==${JSON.stringify(origin)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`, 'fresh renderer document');
  await ui.observeInput();
  if (!(await cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(card)}))`)))
    await ui.clickSidebar(options.subject);
  await ui.waitRead(`Boolean(document.querySelector(${JSON.stringify(card)}))`, 'same canonical Task after reload');
  await openDetail();
  const reloadedTask = await options.task(options.taskId);
  assert.deepEqual(reloadedTask.attachments, commentedTask.attachments);
  assert.deepEqual(reloadedTask.comments, commentedTask.comments);
  assert.deepEqual(await options.commands(), retainedCommands, 'reload does not replay upload/comment business intents');
  proof.imageAfterReload = await verifyImage();
  proof.imageOwnerRead = await readAttachment(String(image.id), png);
  proof.commentOwnerRead = await readAttachment(String(files[0]!.id), text);
  assert.ok(proof.imageOwnerRead && proof.commentOwnerRead);
  proof.reloadedScreenshot = await options.screenshot('ui-task-board-attachments-reloaded.png');

  const downloads = join(options.root, 'home/Downloads');
  await mkdir(downloads, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(downloads), downloads);
  const downloadedPath = join(downloads, textName);
  await assert.rejects(stat(downloadedPath), { code: 'ENOENT' });
  // Electron persist:dev is not registered in Browser domain context lookup.
  // Page resolves this captured target's context before the one original UI click.
  options.assertOwnedRenderer();
  const targetInfo = row(row(await cdp.send('Target.getTargetInfo')).targetInfo);
  assert.equal(targetInfo.type, 'page');
  assert.equal(typeof targetInfo.browserContextId, 'string');
  assert.ok(String(targetInfo.browserContextId).length > 0);
  const downloadPolicy = { behavior: 'allow', downloadPath: downloads };
  await cdp.send('Page.setDownloadBehavior', downloadPolicy);
  proof.downloadPolicy = { method: 'Page.setDownloadBehavior', ...downloadPolicy, rendererBrowserContextId: targetInfo.browserContextId, acknowledged: true, scope: 'captured TEST renderer context via current Page target' };
  const commentTile = `[role="dialog"] [data-task-comment-id=${JSON.stringify(comment.id)}] div.group.relative.flex.size-14`;
  await ui.scrollTo(commentTile, 'original comment attachment download tile');
  await ui.waitRead(`document.querySelector(${JSON.stringify(commentTile)})?.textContent.trim()===${JSON.stringify(textName)}`, 'exact original comment file tile');
  proof.downloadAttempt = { path: downloadedPath, state: 'attempted', budgetMs: 45_000, nativePicker: false };
  await ui.click(commentTile, 'download original comment file once');
  const deadline = Date.now() + 45_000;
  let downloaded: Buffer | undefined;
  while (Date.now() < deadline) {
    options.assertOwnedRenderer();
    try { if ((await stat(downloadedPath)).size === text.length) { downloaded = await readFile(downloadedPath); break; } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await new Promise<void>(done => setTimeout(done, 100));
  }
  assert.ok(downloaded, 'one original download completes; no click replay');
  assert.deepEqual(downloaded, text);
  proof.download = { path: downloadedPath, size: downloaded.length, sha256: sha(downloaded) };
  const deleteSelector = `[role="dialog"] div.group.relative:has(>img[alt=${JSON.stringify(imageName)}]) > button`;
  await ui.scrollTo(deleteSelector, 'original Task image delete overlay');
  await ui.click(deleteSelector, 'remove original Task attachment once');
  const removedTask = await options.waitProduct(() => options.task(options.taskId), value => !rows(value.attachments ?? []).some(item => item.id === image.id), 'Task attachment reference removed');
  assert.deepEqual(removedTask.comments, reloadedTask.comments, 'Task file removal preserves comment attachment');
  proof.removeReceipt = await options.receiptFor('task.attachment.remove', options.taskId, payload => payload.attachmentId === image.id);
  assert.equal(row(proof.removeReceipt).phase, 'completed');
  await ui.waitRead(`!document.querySelector(${JSON.stringify(imageSelector)})`, 'removed Task image absent from UI');
  assert.equal(await readAttachment(String(image.id), png), null, 'removed metadata no longer admits owned blob reads');
  assert.ok(await readAttachment(String(files[0]!.id), text), 'comment reference remains readable');
  proof.removedScreenshot = await options.screenshot('ui-task-board-attachment-removed.png');
  await ui.scrollTo('[role="dialog"] button', 'original Task detail Close', 'Close');
  await ui.click('[role="dialog"] button', 'close original Task detail', 'Close');
  await ui.waitRead(`!document.querySelector('[role="dialog"]')`, 'Task detail closed');
  proof.status = 'PASS';
}
