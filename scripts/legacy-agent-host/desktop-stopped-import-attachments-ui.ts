import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createDesktopUiControls } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { StoppedImportUiSeed } from './desktop-stopped-import-fixture.ts';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Read actual owner props; dev transforms and memo wrappers may rename component functions. */
export function readStoppedImportAttachmentOwner(fiber: unknown, taskId: string) {
  let cursor = fiber;
  for (let depth = 0; cursor && typeof cursor === 'object' && depth < 128; depth++) {
    const entry = cursor as { memoizedProps?: Record<string, unknown>; return?: unknown };
    const props = entry.memoizedProps;
    const task = props?.task;
    if (task && typeof task === 'object' && typeof props?.teamName === 'string') {
      const selected = task as Record<string, unknown>;
      if (selected.id === taskId)
        return {
          teamName: props.teamName,
          taskId: selected.id,
          reference: selected.sourceMessageId ?? null,
        };
    }
    cursor = entry.return;
  }
  return null;
}
/** Existing original controls only. DOM evaluation reads state; user actions use captured CDP input. */
export async function runDesktopStoppedImportAttachmentUi(
  cdp: UiCdpPort,
  options: {
    fixtureRoot: string;
    seed: StoppedImportUiSeed;
    selection: string;
    handleId: string;
    evidence: Record<string, unknown>;
    snapshotTask: Record<string, unknown>;
    openTeams(): Promise<void>;
    screenshot(name: string): Promise<{ path: string; sha256: string }>;
    step(value: Record<string, unknown>): void;
    assertOwnedRenderer(): void;
  }
): Promise<Record<string, unknown>> {
  const { seed } = options;
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE',
    scope:
      'Original canonical imported Team Kanban → source thumbnail/lightbox → Task detail source thumbnail and bounded bytes/download; no Launch Submit',
    screenshots: [],
  };
  options.evidence.attachmentsUi = proof;
  assert.match(options.selection, /^host-team:/);
  assert.equal(options.snapshotTask.id, seed.taskId);
  const reference = String(options.snapshotTask.sourceMessageId);
  assert.match(reference, new RegExp(`^im1:${seed.taskId}:[a-f0-9]{64}$`));
  assert.notEqual(reference, seed.sourceMessage.messageId);
  const source = record(options.snapshotTask.sourceMessage);
  assert.equal(source.text, 'TEST existing imported source-message context');
  for (const expected of [seed.sourceMessage.image, seed.sourceMessage.file]) {
    const metadata = (source.attachments as unknown[])
      .map(record)
      .find((row) => row.id === expected.id);
    assert.ok(metadata);
    assert.equal(metadata.filePath, undefined);
    for (const key of ['filename', 'mimeType', 'size'] as const)
      assert.equal(metadata[key], expected[key]);
  }
  proof.sourceBinding = {
    selection: options.selection,
    handleId: options.handleId,
    taskId: seed.taskId,
    reference,
    snapshotSource: source,
  };
  const ui = createDesktopUiControls(cdp, options);
  const screenshot = async (name: string) => {
    (proof.screenshots as unknown[]).push(await options.screenshot(name));
  };
  const escape = async () => {
    options.assertOwnedRenderer();
    options.step({ action: 'key', key: 'Escape', state: 'attempted' });
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
  };
  const imageBytes = async (selector: string, label: string) => {
    const observed = record(
      await ui.waitRead(
        `(() => {
      const images=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e instanceof HTMLImageElement&&e.complete&&e.naturalWidth===2&&e.naturalHeight===1);
      if(images.length!==1)return null;const image=images[0];return {src:image.currentSrc||image.src,width:image.naturalWidth,height:image.naturalHeight};
    })()`,
        label
      )
    );
    assert.match(String(observed.src), /^data:image\/png;base64,/);
    const bytes = Buffer.from(String(observed.src).split(',')[1]!, 'base64');
    assert.equal(bytes.length, seed.sourceMessage.image.size);
    assert.equal(digest(bytes), seed.sourceMessage.image.sha256);
    return {
      width: observed.width,
      height: observed.height,
      sha256: digest(bytes),
    };
  };
  await options.openTeams();
  const teamSelector = `.team-row-zebra-card[data-team-name=${JSON.stringify(options.selection)}]`;
  await ui.scrollTo(teamSelector, 'canonical imported Team identity');
  await ui.click(teamSelector, 'open original canonical imported Team card once');
  const taskSelector = `.kanban-task-card[data-task-id=${JSON.stringify(seed.taskId)}]`;
  await ui.scrollTo(taskSelector, 'original imported Task Kanban card');
  const selectedOwner = record(
    await ui.waitRead(
      `(() => {
    const node=document.querySelector(${JSON.stringify(taskSelector)});if(!node)return null;
    const key=Object.keys(node).find(key=>key.startsWith('__reactFiber$'));
    return (${readStoppedImportAttachmentOwner.toString()})(key?node[key]:null,${JSON.stringify(seed.taskId)});
  })()`,
      'canonical owner of existing Team Detail'
    )
  );
  assert.deepEqual(selectedOwner, { teamName: options.selection, taskId: seed.taskId, reference });
  proof.kanbanOwner = selectedOwner;
  // Actual Main -> Host read supplements the UI oracle and identifies transport
  // refusals instead of losing their reason inside the mosaic's empty preview.
  options.assertOwnedRenderer();
  const metadataRead = record(await cdp.evaluate(`window.electronAPI.agentBackend.invoke(${JSON.stringify({
    handle: { handleId: options.handleId }, commandId: randomUUID(),
    operation: 'message.attachments.read', payload: { reference },
  })})`));
  proof.metadataRead = metadataRead;
  assert.equal(metadataRead.ok, true, `actual source metadata read: ${JSON.stringify(metadataRead)}`);
  assert.ok(Array.isArray(metadataRead.value));
  assert.deepEqual((metadataRead.value as unknown[]).map(record).map(value => value.id).sort(),
    [seed.sourceMessage.image.id, seed.sourceMessage.file.id].sort());
  const sourceTile = `${taskSelector} button[data-attachment-source="source-message"][aria-label=${JSON.stringify(seed.sourceMessage.image.filename)}]`;
  await ui.scrollTo(sourceTile, 'original source-message Kanban thumbnail');
  proof.kanbanThumbnail = await imageBytes(
    sourceTile + ' img',
    'actual PNG decoded in original Kanban mosaic'
  );
  await screenshot('ui-import-source-attachment-kanban.png');
  await ui.click(sourceTile, 'open original source image lightbox once');
  proof.lightboxImage = await imageBytes(
    `.yarl__root img.yarl__slide_image[alt=${JSON.stringify(seed.sourceMessage.image.filename)}]`,
    'original lightbox actual source PNG'
  );
  await screenshot('ui-import-source-attachment-lightbox.png');
  await escape();
  await ui.waitRead('!document.querySelector(".yarl__root")', 'source lightbox closed');
  // The card has two direct mb-2 containers once attachments load. Select its
  // actual subject heading, outside the image button and Task Start controls.
  assert.equal(typeof options.snapshotTask.subject, 'string');
  const subject = String(options.snapshotTask.subject);
  await ui.scrollTo(`${taskSelector} h5`, 'original Task subject', subject);
  await ui.click(`${taskSelector} h5`, 'open original imported Task detail once', subject);
  const taskOwner = record(
    await ui.waitRead(
      `(() => {
    const node=document.querySelector('[role="dialog"]');if(!node)return null;
    const key=Object.keys(node).find(key=>key.startsWith('__reactFiber$'));
    return (${readStoppedImportAttachmentOwner.toString()})(key?node[key]:null,${JSON.stringify(seed.taskId)});
  })()`,
      'original Task detail exact owner/task/source binding'
    )
  );
  assert.deepEqual(taskOwner, {
    teamName: options.selection,
    taskId: seed.taskId,
    reference,
  });
  proof.taskDetailOwner = taskOwner;
  const detailImage = `[role="dialog"] img[alt=${JSON.stringify(seed.sourceMessage.image.filename)}]`;
  await ui.scrollTo(detailImage, 'original Task detail source attachments');
  proof.taskDetailThumbnail = await imageBytes(
    detailImage,
    'actual source image in original AttachmentDisplay'
  );
  // Read-only exact Host reference, not an ambient legacy message or filesystem path.
  const chunks: Buffer[] = [];
  let offset = 0,
    expectedSha256: string | undefined;
  for (let count = 0; count < 55; count++) {
    options.assertOwnedRenderer();
    const request = {
      handle: { handleId: options.handleId },
      commandId: randomUUID(),
      operation: 'message.attachment.read',
      payload: {
        reference,
        attachmentId: seed.sourceMessage.file.id,
        offset,
        ...(expectedSha256 ? { expectedSha256 } : {}),
      },
    };
    const readStarted = Date.now();
    const result = record(
      await cdp.evaluate(`window.electronAPI.agentBackend.invoke(${JSON.stringify(request)})`)
    );
    const observations = (proof.ownerReadRequests ??= []) as unknown[];
    observations.push({ commandId: request.commandId, offset, elapsedMs: Date.now() - readStarted,
      ok: result.ok, code: typeof result.code === 'string' ? result.code.slice(0, 128) : null,
      outcome: typeof result.outcome === 'string' ? result.outcome.slice(0, 128) : null });
    assert.equal(result.ok, true, JSON.stringify(observations.at(-1)));
    const value = record(result.value),
      metadata = record(value.attachment);
    assert.equal(value.offset, offset);
    assert.equal(metadata.id, seed.sourceMessage.file.id);
    assert.equal(metadata.filePath, undefined);
    assert.equal(value.sha256, seed.sourceMessage.file.sha256);
    assert.equal(metadata.size, seed.sourceMessage.file.size);
    const bytes = Buffer.from(String(value.base64), 'base64');
    assert.ok(bytes.length <= 384 * 1024);
    chunks.push(bytes);
    expectedSha256 = String(value.sha256);
    if (value.nextOffset === null) break;
    assert.equal(value.nextOffset, offset + bytes.length);
    offset = Number(value.nextOffset);
    assert.ok(offset <= 20 * 1024 * 1024);
  }
  const readBytes = Buffer.concat(chunks);
  assert.equal(readBytes.length, seed.sourceMessage.file.size);
  assert.equal(digest(readBytes), seed.sourceMessage.file.sha256);
  proof.ownerReadBytes = {
    sha256: digest(readBytes),
    size: readBytes.length,
    reference,
  };
  // Scope the TEST download policy to this captured Page target. Configuring
  // Chromium's default context does not control Electron's persist:dev partition.
  const directory = join(options.fixtureRoot, 'home/Downloads');
  assert.equal(await realpath(options.fixtureRoot), options.fixtureRoot);
  await mkdir(directory, { mode: 0o700, recursive: true });
  assert.equal(await realpath(directory), directory);
  assert.equal(seed.sourceMessage.file.filename, 'source-original.txt');
  const path = join(directory, seed.sourceMessage.file.filename);
  await assert.rejects(stat(path), { code: 'ENOENT' });
  options.assertOwnedRenderer();
  const targetInfo = record(record(await cdp.send('Target.getTargetInfo')).targetInfo);
  assert.equal(targetInfo.type, 'page');
  assert.equal(typeof targetInfo.browserContextId, 'string');
  assert.ok(String(targetInfo.browserContextId).length > 0);
  const downloadPolicy = { behavior: 'allow', downloadPath: directory };
  await cdp.send('Page.setDownloadBehavior', downloadPolicy);
  options.assertOwnedRenderer();
  proof.downloadPolicy = {
    method: 'Page.setDownloadBehavior',
    ...downloadPolicy,
    rendererBrowserContextId: targetInfo.browserContextId,
    acknowledged: true,
    scope: 'captured TEST renderer context via current Page target',
  };
  const selector = `[role="dialog"] button[aria-label=${JSON.stringify('Download ' + seed.sourceMessage.file.filename)}]`;
  await ui.scrollTo(selector, 'original source file Download tile');
  const downloadAttempt = { path, startedAtMs: Date.now(), clickAcknowledgedAtMs: 0, deadlineAtMs: 0, budgetMs: 45_000 };
  proof.downloadAttempt = downloadAttempt;
  await ui.click(selector, 'download original source bytes once without native picker');
  downloadAttempt.clickAcknowledgedAtMs = Date.now();
  // The original retained download completed near the old20s observation bound.
  // Keep one click and a finite window; exact bytes and ownership remain required.
  const deadline = downloadAttempt.clickAcknowledgedAtMs + downloadAttempt.budgetMs;
  downloadAttempt.deadlineAtMs = deadline;
  let downloaded: Buffer | undefined;
  while (Date.now() < deadline) {
    options.assertOwnedRenderer();
    try {
      if ((await stat(path)).size === seed.sourceMessage.file.size) {
        downloaded = await readFile(path);
        break;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await delay(100);
  }
  assert.ok(downloaded, 'original browser download completes; no click replay');
  assert.equal(digest(downloaded), seed.sourceMessage.file.sha256);
  proof.download = { status: 'PASS', path, size: downloaded.length,
    sha256: digest(downloaded), nativePicker: false, target: 'original TEST-home Downloads' };
  await screenshot('ui-import-source-attachment-task-detail.png');
  await ui.scrollTo('[role="dialog"] > button', 'original Task detail Close', 'Close');
  await ui.click('[role="dialog"] > button', 'close original Task detail once', 'Close');
  await ui.waitRead('!document.querySelector("[role=dialog]")', 'original Task detail closed');
  proof.status = 'PASS';
  return proof;
}
