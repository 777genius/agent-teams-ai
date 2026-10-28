import {
  desktopTaskBoardAssignmentReadyExpression,
  desktopTaskCommentInputExpression,
} from './desktop-task-comment-input-target.ts';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
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
type WaitProduct = <T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  label: string
) => Promise<T>;

/** Extension of the existing offline task-board flow; original file/comment controls only. */
export async function runDesktopTaskBoardAttachmentsUi(
  cdp: UiCdpPort,
  options: {
    root: string;
    taskId: string;
    subject: string;
    handleId: string;
    proof: Row;
    assertOwnedRenderer(): void;
    step(value: Row): void;
    task(id: string): Promise<Row>;
    commands(): Promise<Row[]>;
    receiptFor(
      operation: string,
      taskId: string,
      predicate?: (payload: Row) => boolean
    ): Promise<Row>;
    waitProduct: WaitProduct;
    screenshot(name: string): Promise<{ path: string; sha256: string }>;
  }
) {
  assert.equal(await realpath(options.root), options.root);
  const proof: Row = {
    status: 'INCOMPLETE',
    scope:
      'Existing Task image upload/preview, comment text-file upload/download, reload and Task image remove; offline canonical owner',
    limits: {
      taskImageBytes: 20 * 1024 * 1024,
      commentFileBytes: 20 * 1024 * 1024,
      commentBatchBytes: 100 * 1024 * 1024,
      commentFiles: 5,
    },
    excluded: [
      'boundary-size qualification',
      'native image delivery',
      'chat attachments',
      'native picker',
      'cold app restart',
      'blob garbage collection',
    ],
  };
  options.proof.attachments = proof;
  proof.sourceSha256 = sha(await readFile(import.meta.filename));
  const ui = createDesktopUiControls(cdp, options);
  const directory = join(options.root, 'task-board-attachment-inputs');
  await mkdir(directory, { mode: 0o700 });
  assert.equal(await realpath(directory), directory);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=',
    'base64'
  );
  const text = Buffer.from('TEST canonical task comment attachment\n');
  const imageName = 'TEST-task-owned.png',
    textName = 'TEST-comment-owned.txt';
  for (const [name, bytes] of [
    [imageName, png],
    [textName, text],
  ] as const)
    await writeFile(join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
  proof.fixtureFiles = [
    { filename: imageName, size: png.length, sha256: sha(png) },
    { filename: textName, size: text.length, sha256: sha(text) },
  ];
  const card = `.kanban-task-card[data-task-id=${JSON.stringify(options.taskId)}] h5`;
  const commentExpression = desktopTaskCommentInputExpression(options.handleId, options.taskId);
  let commentInput = '';
  const openDetail = async () => {
    if (!(await cdp.evaluate(`Boolean(document.querySelector('[role="dialog"]'))`))) {
      await ui.scrollTo(card, 'same canonical Task subject');
      await ui.click(card, 'open same Task detail once');
    }
    const target = row(
      await ui.waitRead(commentExpression, 'exact current Task/owner/surface comment input')
    );
    assert.equal(typeof target.selector, 'string');
    commentInput = String(target.selector); // Re-resolve after reload: the original surface ID changes.
    options.step({ assertion: 'exact original Task comment owner/surface', ...target });
    return target;
  };
  const imageSelector = `[role="dialog"] img[alt=${JSON.stringify(imageName)}]`;
  const imageLoaded = () =>
    ui.waitRead(
      `(() => {const e=document.querySelector(${desktopJsLiteral(imageSelector)});return e?.complete&&e.naturalWidth===2&&e.naturalHeight===1?{src:e.currentSrc||e.src,width:e.naturalWidth,height:e.naturalHeight}:null;})()`,
      'original Task PNG decoded'
    );
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
    const found = row(
      await cdp.send('DOM.querySelectorAll', { nodeId: row(document.root).nodeId, selector })
    );
    assert.ok(
      Array.isArray(found.nodeIds) && found.nodeIds.length === 1,
      'one original file input'
    );
    options.step({
      action: 'DOM.setFileInputFiles',
      selector,
      filename: path.split('/').at(-1),
      state: 'attempted',
      nativePicker: false,
    });
    options.assertOwnedRenderer();
    await cdp.send('DOM.setFileInputFiles', { nodeId: found.nodeIds[0], files: [path] });
  };
  const readAttachment = async (id: string, expected: Buffer): Promise<Row | null> => {
    options.assertOwnedRenderer();
    const result = row(
      await cdp.evaluate(
        `window.electronAPI.agentBackend.invoke(${desktopJsLiteral({ handle: { handleId: options.handleId }, commandId: randomUUID(), operation: 'task.attachment.read', payload: { taskId: options.taskId, attachmentId: id, offset: 0 } })})`
      )
    );
    assert.equal(result.ok, true, 'actual read-only captured Host attachment result');
    if (result.value === null) return null;
    const value = row(result.value),
      metadata = row(value.attachment);
    assert.equal(metadata.id, id);
    assert.equal(metadata.filePath, undefined);
    assert.equal(metadata.artifactId, undefined);
    assert.equal(metadata.size, expected.length);
    assert.equal(value.offset, 0);
    assert.equal(value.nextOffset, null);
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
    assert.equal(ref.byteLength, expected.length);
    assert.equal(ref.digest, sha(expected));
    assert.equal(ref.mimeType, metadata.mimeType);
    assert.equal(ref.filePath, undefined);
    assert.equal(ref.base64Data, undefined);
    return ref;
  };

  const originalCommentOwner = await openDetail();
  const imageInput =
    '[role="dialog"] input[type="file"][accept="image/png,image/jpeg,image/gif,image/webp"]';
  if (!(await cdp.evaluate(`Boolean(document.querySelector(${desktopJsLiteral(imageInput)}))`))) {
    // Derive a unique selector from the existing section header; never create a control.
    const header = await ui.waitRead(
      `(() => {const d=document.querySelector('[role="dialog"]');const sections=[...d.querySelectorAll('section')].filter(s=>[...s.querySelectorAll(':scope > div span')].some(e=>e.textContent.trim()==='Attachments'));if(sections.length!==1)return null;let e=sections[0].querySelector('button[aria-label="Expand section"]');if(!e)return null;const path=[];while(e!==d){path.unshift(e.localName+':nth-child('+([...e.parentElement.children].indexOf(e)+1)+')');e=e.parentElement;}return '[role="dialog"] > '+path.join(' > ');})()`,
      'existing collapsed Attachments section'
    );
    assert.equal(typeof header, 'string');
    await ui.scrollTo(String(header), 'original Attachments section header');
    await ui.click(String(header), 'expand original Attachments once');
  }
  await setOriginalFileInput(imageInput, join(directory, imageName));
  const addedTask = await options.waitProduct(
    () => options.task(options.taskId),
    (value) => rows(value.attachments ?? []).some((item) => item.filename === imageName),
    'one canonical Task image'
  );
  const images = rows(addedTask.attachments).filter((item) => item.filename === imageName);
  assert.equal(images.length, 1);
  const image = images[0]!;
  const addReceipt = await options.receiptFor('task.attachment.add', options.taskId);
  proof.imageReference = reference(addReceipt, image, png);
  proof.addReceipt = addReceipt;
  proof.imageBeforeReload = await verifyImage();
  proof.addedScreenshot = await options.screenshot('ui-task-board-attachment-added.png');

  const commentText = 'TEST attachment comment original';
  const readyCommentExpression = desktopTaskBoardAssignmentReadyExpression(options.handleId, options.taskId, {
    contextId: String(row(originalCommentOwner.identity).contextId),
    surfaceId: String(originalCommentOwner.surfaceId),
  }, 'in-progress-comment');
  const commentInputObservations: Row = {};
  proof.commentInputObservations = commentInputObservations;
  const readCommentInput = async (stage: string) => {
    options.assertOwnedRenderer();
    const observed = row(await cdp.evaluate(`(async()=>{
      const settled=await ${readyCommentExpression},owner=${commentExpression};
      const input=owner?document.querySelector(owner.selector):null,active=document.activeElement;
      return {owner,settled:Boolean(settled&&owner&&settled.inputId===owner.inputId&&settled.ownerRevision===owner.ownerRevision),
        domValue:input?.value??null,inputEnabled:input instanceof HTMLTextAreaElement&&!input.disabled,
        focused:input!==null&&active===input,documentFocused:document.hasFocus(),visibility:document.visibilityState,
        activeElement:active?{tag:active.tagName,id:active.id}:null,timeMs:Math.round(performance.now())};
    })()`));
    commentInputObservations[stage] = observed;
    return observed;
  };
  const commentReady = (observed: Row, expectedText: string, attachmentCount: number) => {
    const owner = observed.owner ? row(observed.owner) : undefined;
    return observed.settled === true && observed.inputEnabled === true && observed.visibility === 'visible' &&
      observed.domValue === expectedText && owner && owner.selector === commentInput &&
      owner.commentText === expectedText && owner.submitPending === false && owner.submitError === null &&
      owner.pendingAttachmentCount === attachmentCount && owner.pendingPreparationCount === 0 &&
      owner.canSubmit === true && owner.attachmentError === null;
  };
  const settledComment = await options.waitProduct(
    () => readCommentInput('after image refresh'),
    (value) => Boolean(commentReady(value, '', 0)),
    'same original Task comment owner and empty draft after image refresh'
  );
  commentInput = String(row(settledComment.owner).selector);
  await ui.scrollTo(commentInput, 'original Task comment Composer');
  await ui.click(commentInput, 'focus original Task comment');
  const focusedComment = await readCommentInput('after one focus click');
  assert.ok(commentReady(focusedComment, '', 0), 'same settled empty comment input before typing');
  assert.equal(focusedComment.focused, true, 'one focus click reaches the exact original textarea');
  assert.equal(focusedComment.documentFocused, true, 'original document is focused before typing');
  options.assertOwnedRenderer();
  options.step({ action: 'Input.insertText', text: commentText, selector: commentInput, state: 'attempted' });
  await cdp.send('Input.insertText', { text: commentText });
  await options.waitProduct(
    () => readCommentInput('after one text insertion'),
    (value) => Boolean(commentReady(value, commentText, 0)),
    'one original comment insertion reaches both DOM and current controller session'
  );
  await setOriginalFileInput(
    '[role="dialog"] input[type="file"][accept="*/*"]',
    join(directory, textName)
  );
  await ui.waitRead(
    `document.querySelector('[role="dialog"]')?.textContent.includes(${desktopJsLiteral(textName)})`,
    'original pending comment file preview'
  );
  await options.waitProduct(
    () => readCommentInput('after file preparation'),
    (value) => Boolean(commentReady(value, commentText, 1)),
    'prepared original file preserves exact DOM and controller comment text'
  );
  await ui.scrollTo('[role="dialog"] button', 'original Comment submit', 'Comment');
  assert.ok(commentReady(await readCommentInput('immediately before submit'), commentText, 1),
    'exact original text and prepared file are still current before the one Comment click');
  await ui.click('[role="dialog"] button', 'submit original comment and file once', 'Comment');
  const commentedTask = await options.waitProduct(
    () => options.task(options.taskId),
    (value) =>
      rows(value.comments ?? []).some((item) => item.text === 'TEST attachment comment original'),
    'canonical comment with attachment'
  );
  const comments = rows(commentedTask.comments).filter(
    (item) => item.text === 'TEST attachment comment original'
  );
  assert.equal(comments.length, 1);
  const comment = comments[0]!,
    files = rows(comment.attachments);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.filename, textName);
  const commentReceipt = await options.receiptFor(
    'task.comment',
    options.taskId,
    (payload) => payload.text === comment.text
  );
  proof.commentReference = reference(commentReceipt, files[0]!, text, true);
  proof.commentReceipt = commentReceipt;
  // A canonical receipt precedes completion of refreshTeamData and durable draft cleanup.
  // Observe the original controller and the existing repository; never clear TEST input here.
  const submitted = row(
    await ui.waitRead(
      `(() => {const t=${commentExpression};if(!t||t.selector!==${desktopJsLiteral(commentInput)}||t.commentText!==''||t.submitPending!==false||t.submitError!==null||t.pendingAttachmentCount!==0)return null;const e=document.querySelector(t.selector);return e?.value===''?t:null;})()`,
      'original comment submission completed with an empty Composer'
    )
  );
  const draftIdentity = row(submitted.identity);
  assert.equal(draftIdentity.contextId, 'local');
  const draftKeys = [
    JSON.stringify([
      'task-comment',
      draftIdentity.contextId,
      draftIdentity.teamName,
      options.taskId,
    ]),
    JSON.stringify([
      'task-comment-chips',
      draftIdentity.contextId,
      draftIdentity.teamName,
      options.taskId,
    ]),
    `taskComment:${draftIdentity.teamName}:${options.taskId}`,
    `taskCommentChips:${draftIdentity.teamName}:${options.taskId}`,
  ].map((key) => 'draft:' + key);
  const draftRead = `(async()=>{
    if(!(await indexedDB.databases()).some(d=>d.name==='keyval-store'))return null;
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('keyval-store');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onupgradeneeded=()=>{r.transaction.abort();reject(Error('existing draft database missing'));};});
    try{return await new Promise((resolve,reject)=>{
      const tx=db.transaction('keyval','readonly'),store=tx.objectStore('keyval');
      const values=${desktopJsLiteral(draftKeys)}.map(key=>{const r=store.get(key);return r;});
      tx.oncomplete=()=>resolve({durableEmpty:values.every((r,i)=>r.result==null||r.result.value===(i%2===0?'':'[]'))});
      tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('draft read aborted'));
    });}finally{db.close();}
  })()`;
  proof.commentComposerCompleted = submitted;
  proof.commentDraftBeforeReload = await options.waitProduct(
    async () => {
      options.assertOwnedRenderer();
      const evaluation = row(
        await cdp.send('Runtime.evaluate', {
          expression: draftRead,
          awaitPromise: true,
          returnByValue: true,
        })
      );
      assert.equal(
        evaluation.exceptionDetails,
        undefined,
        'existing draft repository readonly read'
      );
      return row(row(evaluation.result).value);
    },
    (value) => value.durableEmpty === true,
    'submitted draft durably cleared before reload'
  );
  const retainedCommands = await options.commands();
  const origin = await cdp.evaluate('performance.timeOrigin');
  options.assertOwnedRenderer();
  options.step({ action: 'Page.reload', state: 'attempted', scope: 'renderer reload only' });
  await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(
    `performance.timeOrigin!==${desktopJsLiteral(origin)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`,
    'fresh renderer document'
  );
  await ui.observeInput();
  if (!(await cdp.evaluate(`Boolean(document.querySelector(${desktopJsLiteral(card)}))`)))
    await ui.clickSidebar(options.subject);
  await ui.waitRead(
    `Boolean(document.querySelector(${desktopJsLiteral(card)}))`,
    'same canonical Task after reload'
  );
  await openDetail();
  await ui.waitRead(
    `(() => {const t=${commentExpression};return t?.commentText===''&&t.submitPending===false&&document.querySelector(t.selector)?.value==='';})()`,
    'submitted comment draft stays empty after renderer reload'
  );
  const reloadedTask = await options.task(options.taskId);
  assert.deepEqual(reloadedTask.attachments, commentedTask.attachments);
  assert.deepEqual(reloadedTask.comments, commentedTask.comments);
  assert.deepEqual(
    await options.commands(),
    retainedCommands,
    'reload does not replay upload/comment business intents'
  );
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
  proof.downloadPolicy = {
    method: 'Page.setDownloadBehavior',
    ...downloadPolicy,
    rendererBrowserContextId: targetInfo.browserContextId,
    acknowledged: true,
    scope: 'captured TEST renderer context via current Page target',
  };
  const commentTile = `[role="dialog"] [data-task-comment-id=${JSON.stringify(comment.id)}] div.group.relative.flex.size-14`;
  await ui.scrollTo(commentTile, 'original comment attachment download tile');
  await ui.waitRead(
    `document.querySelector(${desktopJsLiteral(commentTile)})?.textContent.trim()===${desktopJsLiteral(textName)}`,
    'exact original comment file tile'
  );
  proof.downloadAttempt = {
    path: downloadedPath,
    state: 'attempted',
    budgetMs: 45_000,
    nativePicker: false,
  };
  await ui.click(commentTile, 'download original comment file once');
  const deadline = Date.now() + 45_000;
  let downloaded: Buffer | undefined;
  while (Date.now() < deadline) {
    options.assertOwnedRenderer();
    try {
      if ((await stat(downloadedPath)).size === text.length) {
        downloaded = await readFile(downloadedPath);
        break;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise<void>((done) => setTimeout(done, 100));
  }
  assert.ok(downloaded, 'one original download completes; no click replay');
  assert.deepEqual(downloaded, text);
  proof.download = { path: downloadedPath, size: downloaded.length, sha256: sha(downloaded) };
  const deleteSelector = `[role="dialog"] div.group.relative:has(>img[alt=${JSON.stringify(imageName)}]) > button`;
  await ui.scrollTo(deleteSelector, 'original Task image delete overlay');
  await ui.click(deleteSelector, 'remove original Task attachment once');
  const removedTask = await options.waitProduct(
    () => options.task(options.taskId),
    (value) => !rows(value.attachments ?? []).some((item) => item.id === image.id),
    'Task attachment reference removed'
  );
  assert.deepEqual(
    removedTask.comments,
    reloadedTask.comments,
    'Task file removal preserves comment attachment'
  );
  proof.removeReceipt = await options.receiptFor(
    'task.attachment.remove',
    options.taskId,
    (payload) => payload.attachmentId === image.id
  );
  assert.equal(row(proof.removeReceipt).phase, 'completed');
  await ui.waitRead(
    `!document.querySelector(${desktopJsLiteral(imageSelector)})`,
    'removed Task image absent from UI'
  );
  assert.equal(
    await readAttachment(String(image.id), png),
    null,
    'removed metadata no longer admits owned blob reads'
  );
  assert.ok(await readAttachment(String(files[0]!.id), text), 'comment reference remains readable');
  proof.removedScreenshot = await options.screenshot('ui-task-board-attachment-removed.png');
  await ui.scrollTo('[role="dialog"] button', 'original Task detail Close', 'Close');
  await ui.click('[role="dialog"] button', 'close original Task detail', 'Close');
  await ui.waitRead(`!document.querySelector('[role="dialog"]')`, 'Task detail closed');
  proof.status = 'PASS';
}
