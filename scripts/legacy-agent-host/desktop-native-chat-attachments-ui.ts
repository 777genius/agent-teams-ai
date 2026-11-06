import { hostTeamSelectionKey } from '../../src/features/agent-backend/contracts/teamSelection.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CHAT_PNG,
  CHAT_PREPARED_IMAGE_NAME,
  assertChatImagePixels,
  CHAT_TEXT,
  CHAT_IMAGE_NAME,
  CHAT_FILE_NAME,
} from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/chat-attachments.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Extends the original conversation Composer; never opens a native picker or sends another input. */
export async function prepareNativeChatAttachments(
  cdp: UiCdpPort,
  options: {
    root: string;
    evidence: Record<string, unknown>;
    assertOwnedRenderer(): void;
    step(value: Record<string, unknown>): void;
  }
) {
  const ui = createDesktopUiControls(cdp, options);
  const directory = join(options.root, 'native-chat-attachment-inputs');
  await mkdir(directory, { mode: 0o700 });
  assert.equal(await realpath(directory), directory);
  const png = Buffer.from(CHAT_PNG, 'base64'),
    text = Buffer.from(CHAT_TEXT);
  for (const [name, bytes] of [
    [CHAT_IMAGE_NAME, png],
    [CHAT_FILE_NAME, text],
  ] as const)
    await writeFile(join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
  options.assertOwnedRenderer();
  const control = row(
    await ui.waitRead(
      `(() => {
    const area=document.activeElement;
    if(!(area instanceof HTMLTextAreaElement)||area.value!=='NATIVE_TEAM_TWO')return null;
    const composer=area.closest('.message-composer-flat-layout');
    const inputs=composer?.querySelectorAll('input[type="file"]');
    if(!inputs||inputs.length!==1)return null;
    const attach=inputs[0].parentElement?.querySelector('button');
    return attach instanceof HTMLButtonElement&&!attach.disabled?{textareaId:area.id,fileInputs:inputs.length}:null;
  })()`,
      'the focused original Composer exposes its enabled attachment input'
    )
  );
  assert.equal(typeof control.textareaId, 'string');
  options.evidence.nativeChatAttachmentControl = control;
  const composerSelector = `.message-composer-flat-layout:has(textarea[id=${JSON.stringify(control.textareaId)}])`;
  const document = row(await cdp.send('DOM.getDocument', { depth: 0 }));
  const found = row(
    await cdp.send('DOM.querySelectorAll', {
      nodeId: row(document.root).nodeId,
      selector: `${composerSelector} input[type="file"]`,
    })
  );
  assert.ok(Array.isArray(found.nodeIds) && found.nodeIds.length === 1);
  options.step({
    action: 'DOM.setFileInputFiles',
    filenames: [CHAT_IMAGE_NAME, CHAT_FILE_NAME],
    nativePicker: false,
    state: 'attempted',
  });
  await cdp.send('DOM.setFileInputFiles', {
    nodeId: found.nodeIds[0],
    files: [join(directory, CHAT_IMAGE_NAME), join(directory, CHAT_FILE_NAME)],
  });
  await ui.waitRead(
    `(() => {const e=document.querySelector(${desktopJsLiteral(composerSelector)});return Boolean(e)&&e.textContent.includes(${desktopJsLiteral(CHAT_FILE_NAME)})&&Boolean(e.querySelector('img'));})()`,
    'both original pending chat attachment controls'
  );
  const pendingSelector = `${composerSelector} img[alt=${JSON.stringify(CHAT_IMAGE_NAME)}]`;
  const pending = row(
    await ui.waitRead(
      `(() => {const e=[...document.querySelectorAll(${desktopJsLiteral(pendingSelector)})];return e.length===1&&e[0].complete&&e[0].naturalWidth===2&&e[0].naturalHeight===1?{src:e[0].currentSrc||e[0].src}:null;})()`,
      'exact prepared pending image before the original Send'
    )
  );
  assert.match(String(pending.src), /^data:image\/png;base64,/);
  // The real image optimizer may reencode. Independently verify known source pixels
  // before retaining these observed bytes as the exact publication/preview expectation.
  assertChatImagePixels(CHAT_PNG);
  const preparedPng = assertChatImagePixels(String(pending.src).split(',')[1]);
  await writeFile(join(directory, CHAT_PREPARED_IMAGE_NAME), preparedPng, {
    flag: 'wx',
    mode: 0o600,
  });
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE',
    files: [
      { filename: CHAT_IMAGE_NAME, mimeType: 'image/png', size: png.length, sha256: sha(png) },
      { filename: CHAT_FILE_NAME, mimeType: 'text/plain', size: text.length, sha256: sha(text) },
    ],
    preparedImage: {
      filename: CHAT_PREPARED_IMAGE_NAME,
      originalFilename: CHAT_IMAGE_NAME,
      mimeType: 'image/png',
      size: preparedPng.length,
      sha256: sha(preparedPng),
      width: 2,
      height: 1,
      source: 'existing Composer pending image before Send',
    },
    nativeInference: 'Actual SDK/CLI to localhost; vendor authentication not qualified',
  };
  options.evidence.nativeChatAttachments = proof;
  return async (messageId: string) => {
    assert.match(messageId, /^[a-f0-9-]{36}$/);
    const descriptor = row(
      JSON.parse(await readFile(join(options.root, 'desktop-descriptor.json'), 'utf8'))
    );
    assert.ok(Array.isArray(descriptor.handles) && descriptor.handles.length === 1);
    const handle = row(descriptor.handles[0]);
    assert.equal(typeof handle.handleId, 'string');
    const teamName = hostTeamSelectionKey(String(handle.handleId));
    const messageRow = `[data-timeline-row-key=${JSON.stringify(messageId)}]`;
    const article = `${messageRow} article.activity-timeline-card`;
    const sentExpression = `(() => {
      const rows=[...document.querySelectorAll(${desktopJsLiteral(article)})];if(rows.length!==1)return null;
      const e=rows[0],key=Object.keys(e).find(k=>k.startsWith('__reactFiber$')),attached=key?e[key]:null;let current=null;
      for(const candidate of [attached,attached?.alternate]){if(!candidate)continue;let r=candidate,n=0;while(r.return&&n++<256)r=r.return;if(!r.return&&r.stateNode?.current===r){current=candidate;break;}}
      for(let f=current,n=0;f&&n++<128;f=f.return){const p=f.memoizedProps,m=p?.message;
        if(p?.teamName!==${desktopJsLiteral(teamName)}||m?.messageId!==${desktopJsLiteral(messageId)}||m.from!=='user'||m.to!=='alice'||m.text!=='NATIVE_TEAM_TWO')continue;
        const a=m.attachments;if(!Array.isArray(a)||a.length!==2||a[0].filename!==${desktopJsLiteral(CHAT_IMAGE_NAME)}||a[0].mimeType!=='image/png'||a[0].size!==${preparedPng.length}||a[1].filename!==${desktopJsLiteral(CHAT_FILE_NAME)}||a[1].mimeType!=='text/plain'||a[1].size!==${text.length})return null;
        return {teamName:p.teamName,messageId:m.messageId,from:m.from,to:m.to,text:m.text,expanded:e.dataset.expanded==='true',attachments:a.map(x=>({id:x.id,filename:x.filename,mimeType:x.mimeType,size:x.size}))};
      }return null;
    })()`;
    const sent = row(
      await ui.waitRead(
        sentExpression,
        'exact original sent message with both public attachment metadata entries'
      )
    );
    if (sent.expanded !== true) {
      const header = `${article} > div[role="button"]`;
      await ui.scrollTo(header, 'original sent attachment message header');
      await ui.click(header, 'expand original sent attachment message once');
    }
    proof.sentMessage = row(
      await ui.waitRead(
        `(() => {const m=${sentExpression};return m?.expanded===true?m:null;})()`,
        'original sent message expanded through its existing header'
      )
    );
    const image = `${article} img[alt=${JSON.stringify(CHAT_IMAGE_NAME)}]`;
    await ui.scrollTo(image, 'original sent message image preview');
    const loaded = row(
      await ui.waitRead(
        `(() => {const e=[...document.querySelectorAll(${desktopJsLiteral(image)})].filter(i=>!i.closest('.message-composer-flat-layout'));return e.length===1&&e[0].complete&&e[0].naturalWidth===2&&e[0].naturalHeight===1?{src:e[0].currentSrc||e[0].src}:null;})()`,
        'original sent message image preview'
      )
    );
    assert.match(String(loaded.src), /^data:image\/png;base64,/);
    assert.deepEqual(Buffer.from(String(loaded.src).split(',')[1]!, 'base64'), preparedPng);
    proof.preview = { sha256: sha(preparedPng), width: 2, height: 1 };
    const downloads = join(options.root, 'home/Downloads');
    await mkdir(downloads, { recursive: true, mode: 0o700 });
    assert.equal(await realpath(downloads), downloads);
    const path = join(downloads, CHAT_FILE_NAME);
    await assert.rejects(stat(path), { code: 'ENOENT' });
    options.assertOwnedRenderer();
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    const control = `${article} button[aria-label=${JSON.stringify('Download ' + CHAT_FILE_NAME)}]`;
    await ui.scrollTo(control, 'sent file original Download');
    await ui.click(control, 'download original sent file once');
    const deadline = Date.now() + 45_000;
    let downloaded: Buffer | undefined;
    while (Date.now() < deadline) {
      options.assertOwnedRenderer();
      try {
        if ((await stat(path)).size === text.length) {
          downloaded = await readFile(path);
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await new Promise<void>((done) => setTimeout(done, 100));
    }
    assert.ok(downloaded, 'one original download completes without click replay');
    assert.deepEqual(downloaded, text);
    proof.download = { filename: CHAT_FILE_NAME, sha256: sha(downloaded), size: downloaded.length };
    proof.status = 'PASS';
  };
}
