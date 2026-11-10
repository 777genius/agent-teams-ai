import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileDigest } from './desktop-backend-fixture.ts';
import { readDesktopReviewSeed } from './desktop-review-fixture.ts';
import {
  createDesktopReviewHunkControls,
  readDesktopReviewDecisions,
} from './desktop-review-hunk-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
/** Original Changes controls, synthetic Task ledger, real filesystem; no native inference claim. */
export async function runDesktopReviewUiSmoke(
  cdp: UiCdpPort,
  options: {
    root: string;
    seed: { taskId: string; subject: string };
    readback: boolean;
    assertOwnedRenderer(): void;
    evidence: Record<string, unknown>;
  }
): Promise<void> {
  const seed = await readDesktopReviewSeed(options.root, options.seed.taskId);
  const steps: Record<string, unknown>[] = [];
  const step = (value: Record<string, unknown>) => {
    steps.push({ monotonicMs: Math.round(performance.now()), ...value });
  };
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE',
    steps,
    scope: options.readback
      ? 'Separate Host/app restart readback and stale external-write guard through original Changes UI'
      : 'Original Task Changes controls: Keep first hunk, Reject second, real immediate filesystem apply, Undo/Redo/history and renderer reload',
    fixture: 'Synthetic exact two-hunk canonical Task ledger; no native capture qualification',
    excluded: [
      'M13 native attribution',
      'native inference',
      'crash recovery injection',
      'Apply button (instant apply is enabled)',
    ],
    taskId: seed.taskId,
    filePath: seed.filePath,
    seedSha256: await fileDigest(join(options.root, 'review-ui-seed.json')),
    sourceSha256: await fileDigest(import.meta.filename),
    fixtureSourceSha256: await fileDigest(join(import.meta.dirname, 'desktop-review-fixture.ts')),
  };
  options.evidence.reviewUiProof = proof;
  const { ui, historySelector, waitHistory, openChanges, hoverLine } =
    createDesktopReviewHunkControls(cdp, {
      taskId: seed.taskId,
      subject: options.seed.subject,
      fileLabel: 'value.ts',
      assertOwnedRenderer: options.assertOwnedRenderer,
      step,
    });
  const assertUnrelated = async () => {
    assert.equal(
      await fileDigest(join(options.root, 'workspace/.git/index')),
      seed.gitIndexSha256,
      'review never stages or resets the original dirty workspace'
    );
    assert.equal(
      await readFile(join(options.root, 'workspace/pre-existing-untracked.txt'), 'utf8'),
      'TEST unrelated dirty file\n'
    );
  };
  const screenshot = async (name: string) => {
    const captured = record(
      await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    );
    const path = join(options.root, name);
    await writeFile(path, Buffer.from(String(captured.data), 'base64'), {
      mode: 0o600,
      flag: 'wx',
    });
    return { path, sha256: await fileDigest(path) };
  };
  await ui.observeInput();
  await openChanges();
  if (!options.readback) {
    assert.equal(await readFile(seed.filePath, 'utf8'), seed.after);
    await hoverLine('const first = 2;');
    await ui.click(
      '[data-review-floating-toolbar="true"] button[title^="Accept change"]',
      'Keep first hunk once'
    );
    await waitHistory(1, 0);
    assert.equal(
      await readFile(seed.filePath, 'utf8'),
      seed.after,
      'Keep persists decision without rewriting file'
    );
    await hoverLine('const last = 2;');
    await ui.click(
      '[data-review-floating-toolbar="true"] button[title^="Reject change"]',
      'Reject second hunk once'
    );
    await waitHistory(2, 0);
    assert.equal(
      await readFile(seed.filePath, 'utf8'),
      seed.mixed,
      'Reject immediately applies exact mixed decisions to real disk'
    );
    await ui.click('button', 'Undo last review mutation once', 'Undo');
    await waitHistory(1, 1);
    assert.equal(await readFile(seed.filePath, 'utf8'), seed.after);
    await ui.click('button', 'Redo original review mutation once', 'Redo');
    await waitHistory(2, 0);
    assert.equal(await readFile(seed.filePath, 'utf8'), seed.mixed);
    await ui.click(historySelector, 'open original History');
    await ui.waitRead(`/undo stack/i.test(document.body.innerText)`, 'original History popover');
    proof.historyScreenshot = await screenshot('ui-review-history.png');
    await ui.click('button[aria-label="Close review history"]', 'close original History');
    await ui.click('button[aria-label="Close Changes"]', 'close and flush original Changes');
    await ui.waitRead(
      `!document.querySelector('button[aria-label="Close Changes"]')`,
      'Changes closed after durable flush'
    );
    proof.beforeRendererReload = await readDesktopReviewDecisions(options.root);
    const origin = await cdp.evaluate('performance.timeOrigin');
    step({ action: 'Page.reload', ignoreCache: false });
    await cdp.send('Page.reload', { ignoreCache: false });
    await ui.waitRead(
      `performance.timeOrigin!==${JSON.stringify(origin)}&&document.readyState==='complete'&&
      Boolean(window.electronAPI)&&!document.getElementById('splash')`,
      'new renderer document'
    );
    await ui.observeInput();
    await openChanges();
    await waitHistory(2, 0);
    assert.equal(await readFile(seed.filePath, 'utf8'), seed.mixed);
    proof.reloadedHistoryScreenshot = await screenshot('ui-review-reloaded.png');
  } else {
    await waitHistory(2, 0);
    assert.equal(
      await readFile(seed.filePath, 'utf8'),
      seed.mixed,
      'separate Host restart preserves mixed disk state'
    );
    proof.restartedHistoryScreenshot = await screenshot('ui-review-host-restarted.png');
    const external = seed.mixed + '// TEST later external writer\n';
    await writeFile(seed.filePath, external, { mode: 0o600 });
    step({
      fixtureAction: 'external TEST filesystem write',
      sha256: await fileDigest(seed.filePath),
    });
    proof.staleGuard = await ui.waitRead(
      `(() => {
      const text=document.body.innerText;
      const undo=[...document.querySelectorAll('button')].filter(e=>e.textContent.trim()==='Undo');
      if(!text.includes('Changed on disk')||undo.length!==1||!undo[0].disabled)return null;
      return {externalChangeBanner:true,undoDisabled:true,text:text.slice(-6000)};
    })()`,
      'existing external-change guard refuses stale review action'
    );
    assert.equal(
      await readFile(seed.filePath, 'utf8'),
      external,
      'stale guard preserves exact external bytes'
    );
    proof.staleScreenshot = await screenshot('ui-review-stale-refused.png');
  }
  await assertUnrelated();
  proof.persistence = await readDesktopReviewDecisions(options.root);
  assert.ok(
    (proof.persistence as unknown[]).length > 0,
    'canonical Host review state exists on disk'
  );
  proof.fileSha256 = await fileDigest(seed.filePath);
  proof.status = 'PASS';
}
