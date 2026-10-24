import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHAT_PNG, CHAT_TEXT, CHAT_IMAGE_NAME, CHAT_FILE_NAME } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/chat-attachments.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Extends the original conversation Composer; never opens a native picker or sends another input. */
export async function prepareNativeChatAttachments(cdp: UiCdpPort, options: {
  root: string; evidence: Record<string, unknown>; assertOwnedRenderer(): void;
  step(value: Record<string, unknown>): void;
}) {
  const ui = createDesktopUiControls(cdp, options);
  const directory = join(options.root, 'native-chat-attachment-inputs');
  await mkdir(directory, { mode: 0o700 });
  assert.equal(await realpath(directory), directory);
  const png = Buffer.from(CHAT_PNG, 'base64'), text = Buffer.from(CHAT_TEXT);
  for (const [name, bytes] of [[CHAT_IMAGE_NAME, png], [CHAT_FILE_NAME, text]] as const)
    await writeFile(join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
  options.assertOwnedRenderer();
  const document = row(await cdp.send('DOM.getDocument', { depth: 0 }));
  const found = row(await cdp.send('DOM.querySelectorAll', {
    nodeId: row(document.root).nodeId, selector: '.message-composer-flat-layout input[type="file"]',
  }));
  assert.ok(Array.isArray(found.nodeIds) && found.nodeIds.length === 1);
  options.step({ action: 'DOM.setFileInputFiles', filenames: [CHAT_IMAGE_NAME, CHAT_FILE_NAME], nativePicker: false, state: 'attempted' });
  await cdp.send('DOM.setFileInputFiles', { nodeId: found.nodeIds[0], files: [join(directory, CHAT_IMAGE_NAME), join(directory, CHAT_FILE_NAME)] });
  await ui.waitRead(`(() => {const e=document.querySelector('.message-composer-flat-layout');return Boolean(e)&&e.textContent.includes(${desktopJsLiteral(CHAT_FILE_NAME)})&&Boolean(e.querySelector('img'));})()`, 'both original pending chat attachment controls');
  const proof: Record<string, unknown> = { status: 'INCOMPLETE', files: [
    { filename: CHAT_IMAGE_NAME, mimeType: 'image/png', size: png.length, sha256: sha(png) },
    { filename: CHAT_FILE_NAME, mimeType: 'text/plain', size: text.length, sha256: sha(text) },
  ], nativeInference: 'Actual SDK/CLI to localhost; vendor authentication not qualified' };
  options.evidence.nativeChatAttachments = proof;
  return async () => {
    const image = `img[alt=${JSON.stringify(CHAT_IMAGE_NAME)}]`;
    const loaded = row(await ui.waitRead(`(() => {const e=[...document.querySelectorAll(${desktopJsLiteral(image)})].filter(i=>!i.closest('.message-composer-flat-layout'));return e.length===1&&e[0].complete&&e[0].naturalWidth===2&&e[0].naturalHeight===1?{src:e[0].currentSrc||e[0].src}:null;})()`, 'original sent message image preview'));
    assert.match(String(loaded.src), /^data:image\/png;base64,/);
    assert.deepEqual(Buffer.from(String(loaded.src).split(',')[1]!, 'base64'), png);
    proof.preview = { sha256: sha(png), width: 2, height: 1 };
    const downloads = join(options.root, 'home/Downloads');
    await mkdir(downloads, { recursive: true, mode: 0o700 });
    assert.equal(await realpath(downloads), downloads);
    const path = join(downloads, CHAT_FILE_NAME);
    await assert.rejects(stat(path), { code: 'ENOENT' });
    options.assertOwnedRenderer();
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    const control = `button[aria-label=${JSON.stringify('Download ' + CHAT_FILE_NAME)}]`;
    await ui.scrollTo(control, 'sent file original Download');
    await ui.click(control, 'download original sent file once');
    const deadline = Date.now() + 45_000;
    let downloaded: Buffer | undefined;
    while (Date.now() < deadline) {
      options.assertOwnedRenderer();
      try { if ((await stat(path)).size === text.length) { downloaded = await readFile(path); break; } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await new Promise<void>(done => setTimeout(done, 100));
    }
    assert.ok(downloaded, 'one original download completes without click replay');
    assert.deepEqual(downloaded, text);
    proof.download = { filename: CHAT_FILE_NAME, sha256: sha(downloaded), size: downloaded.length };
    proof.status = 'PASS';
  };
}
