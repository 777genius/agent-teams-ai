import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, watch } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { digest, fileDigest } from './desktop-backend-fixture.ts';
import { skillsUiMarkdown } from './desktop-skills-fixture.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const pause = () => new Promise<void>((done) => setTimeout(done, 100));
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (path: string, relative: string): Promise<void> => {
    const stat = await lstat(path);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) {
      result[relative + '/'] = 'directory';
      for (const entry of (await readdir(path)).sort())
        await visit(join(path, entry), relative ? relative + '/' + entry : entry);
    } else {
      assert.ok(stat.isFile());
      result[relative] = await fileDigest(path);
    }
    assert.ok(Object.keys(result).length < 100, 'bounded TEST tree');
  };
  await visit(root, '');
  return result;
}

/** Existing Skills controls only; fixture/API calls stage TEST boundary conditions, never substitute UI actions. */
export async function runDesktopSkillsUiSmoke(
  cdp: UiCdpPort,
  options: {
    root: string;
    assertOwnedRenderer(): void;
    evidence: Record<string, unknown>;
  }
): Promise<void> {
  const { root } = options;
  assert.match(root, /\/TEST-desktop-backend-[^/]+$/);
  const fixture = object(JSON.parse(await readFile(join(root, 'skills-ui-fixture.json'), 'utf8')));
  const source = String(fixture.source),
    target = String(fixture.target),
    held = String(fixture.held);
  assert.ok([source, target, held].every((path) => path.startsWith(root + '/')));
  const steps: Record<string, unknown>[] = [];
  const step = (row: Record<string, unknown>) =>
    steps.push({ monotonicMs: Math.round(performance.now()), ...row });
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE',
    steps,
    qaInventory: [
      'Existing typed import source and review: visible binary/hidden warnings, exact target, no target or journal writes',
      'Source changes after review: existing confirm rejects; re-review then applies exact new bytes and preserves unmanaged files/empty directories',
      'Existing Create and Edit dialogs review/apply real SKILL.md changes',
      'Existing Delete confirmation: original inode reaches OS Trash callback, completed original journal, replacement at old name survives',
      'Pre-staged original UNKNOWN Codex intent: existing Delete/retry remains held with original bytes and receipt unchanged',
      'Supported TEST config API replaces original local context while review is open; existing confirm rejects original stale grant without target writes',
    ],
    exclusions: [
      'real projects or credentials',
      'native agents/inference',
      'native folder picker',
      'reading ambient OS Trash inventory',
      'claiming forced unknown native callback from a pre-staged UNKNOWN fixture',
    ],
    sourceSha256: await fileDigest(import.meta.filename),
  };
  options.evidence.skillsUiProof = proof;
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step,
  });
  const input = async (method: string, params: Record<string, unknown>) => {
    options.assertOwnedRenderer();
    return cdp.send(method, params);
  };
  const readUntil = async <T>(
    read: () => Promise<T>,
    matches: (value: T) => boolean,
    label: string
  ): Promise<T> => {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      options.assertOwnedRenderer();
      let value: T;
      try { value = await read(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // Atomic directory publication can briefly remove the read target.
        await pause();
        continue;
      }
      if (matches(value)) return value;
      await pause();
    }
    throw new Error(`Skills product read timed out: ${label}; no mutation retry`);
  };
  const screenshot = async (name: string) => {
    options.assertOwnedRenderer();
    const capture = object(
      await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    );
    assert.equal(typeof capture.data, 'string');
    const path = join(root, name);
    await writeFile(path, Buffer.from(String(capture.data), 'base64'), { mode: 0o600, flag: 'wx' });
    return { path, sha256: await fileDigest(path) };
  };
  const text = async () => String(await cdp.evaluate('document.body.innerText'));
  const waitText = (value: string) =>
    ui.waitRead(`document.body.innerText.includes(${desktopJsLiteral(value)})`, value);
  const fill = async (selector: string, value: string) => {
    await ui.scrollTo(selector, 'reveal ' + selector);
    await ui.click(selector, 'focus ' + selector);
    await input('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: 4,
      commands: ['selectAll'],
    });
    await input('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
    await input('Input.insertText', { text: value });
    await ui.waitRead(
      `document.querySelector(${desktopJsLiteral(selector)})?.value===${desktopJsLiteral(value)}`,
      'typed value ' + selector
    );
  };
  const escape = async () => {
    await input('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await input('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  };
  const clickCard = async (name: string) => {
    await fill('input[placeholder="Search by skill name or what it helps with..."]', name);
    const expression = `(() => {const rows=[...document.querySelectorAll('.skills-grid button')].filter(e=>e.querySelector('h3')?.textContent.trim()===${desktopJsLiteral(name)});if(rows.length!==1)return null;const e=rows[0],r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return r.width>0&&r.height>0&&hit&&(e===hit||e.contains(hit))?{x,y}:null})()`;
    const point = object(await ui.waitRead(expression, 'visible skill card ' + name));
    step({ action: 'mouseClick', label: 'skill card ' + name, target: point, state: 'attempted' });
    await input('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...point,
      button: 'left',
      clickCount: 1,
    });
    await input('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...point,
      button: 'left',
      clickCount: 1,
    });
    await waitText('Edit Skill');
  };
  const journal = async () => {
    const directory = join(root, 'hoststore/management-commands');
    const names = (await readdir(directory))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .sort();
    assert.ok(names.length <= 16);
    return Promise.all(
      names.map(async (name) => object(JSON.parse(await readFile(join(directory, name), 'utf8'))))
    );
  };
  const beforeRows = await journal();
  assert.equal(beforeRows.length, 1);
  const unknownBefore = beforeRows[0]!;
  assert.equal(unknownBefore.commandId, fixture.unknownCommandId);
  const before = await snapshot(target),
    heldBefore = await snapshot(held);
  await ui.observeInput();
  await ui.click('button[aria-label="More actions"]', 'existing More actions');
  await ui.click(
    'div.absolute.right-0.top-full button',
    'existing Extensions menu item',
    'Extensions'
  );
  await ui.click('[role="tab"]', 'existing Skills tab', 'Skills');
  await waitText('test-ui-original');
  proof.initialScreenshot = await screenshot('ui-skills-initial.png');

  await ui.click('button', 'existing Import action', 'Import');
  await fill('#skill-import-source', source);
  await fill('#skill-import-folder', 'test-ui-installed');
  await ui.click('[role="dialog"] button', 'review existing import', 'Review And Import');
  await waitText('Review skill changes');
  await waitText(target);
  await waitText('Binary file preview is not shown.');
  assert.match(await text(), /Hidden files and folders were skipped/);
  assert.deepEqual(await snapshot(target), before);
  assert.deepEqual(await journal(), beforeRows);
  proof.importPreviewScreenshot = await screenshot('ui-skills-import-review.png');
  // Deliberate TEST source mutation after the real review, before the one real confirm.
  await writeFile(join(source, 'SKILL.md'), skillsUiMarkdown(2), { mode: 0o600 });
  await ui.click('[role="dialog"] button', 'confirm stale source once', 'Import Skill');
  await waitText('skill source changed after review');
  assert.deepEqual(await snapshot(target), before);
  assert.deepEqual(await journal(), beforeRows);
  proof.knownRejectedScreenshot = await screenshot('ui-skills-known-rejected.png');
  await ui.click('[role="dialog"] button', 'return to original import editor', 'Back To Import');
  await ui.click('[role="dialog"] button', 'review changed TEST source', 'Review And Import');
  await waitText('test-ui-imported-v2');
  await ui.click('[role="dialog"] button', 'confirm exact new snapshot once', 'Import Skill');
  await readUntil(
    () => readFile(join(target, 'SKILL.md'), 'utf8'),
    (value) => value === skillsUiMarkdown(2),
    'exact imported markdown'
  );
  const applied = await snapshot(target);
  assert.equal(applied['assets/picture.bin'], await fileDigest(join(source, 'assets/picture.bin')));
  assert.equal(
    applied['references/guide.md'],
    await fileDigest(join(source, 'references/guide.md'))
  );
  assert.equal(applied['keep.txt'], before['keep.txt']);
  assert.equal(applied['empty-sidecar/'], 'directory');
  assert.equal(applied['.hidden'], undefined);
  assert.equal(applied['scripts/obsolete.sh'], undefined);
  await ui.waitRead(
    "!document.querySelector('#skill-import-source')&&document.body.innerText.includes('test-ui-imported-v2')",
    'import completed in existing UI'
  );
  proof.importApplied = applied;
  proof.importAppliedScreenshot = await screenshot('ui-skills-import-applied.png');
  await escape();

  await ui.click('button', 'existing Create Skill', 'Create Skill');
  await fill('#skill-name', 'test-ui-created');
  await fill('#skill-folder', 'test-ui-created');
  await fill('#skill-description', 'TEST created through existing UI');
  await fill('#skill-steps', '1. TEST exact create.');
  await ui.click('[role="dialog"] button', 'review created skill', 'Review And Create');
  await waitText('Review skill changes');
  await ui.click('[role="dialog"] button', 'apply created skill once', 'Create Skill');
  const created = join(root, 'claude/skills/test-ui-created');
  await readUntil(
    async () =>
      existsSync(join(created, 'SKILL.md')) ? readFile(join(created, 'SKILL.md'), 'utf8') : '',
    (value) => value.includes('TEST created through existing UI'),
    'created markdown'
  );
  await ui.waitRead(
    "!document.querySelector('#skill-name')&&document.body.innerText.includes('test-ui-created')",
    'created result visible'
  );
  await escape();
  await clickCard('test-ui-created');
  await ui.click('[role="dialog"] button', 'existing Edit Skill', 'Edit Skill');
  await fill('#skill-description', 'TEST edited through existing UI');
  await ui.click('[role="dialog"] button', 'review existing edit', 'Review And Save');
  await waitText('TEST edited through existing UI');
  await ui.click('[role="dialog"] button', 'apply existing edit once', 'Save Skill');
  await readUntil(
    () => readFile(join(created, 'SKILL.md'), 'utf8'),
    (value) => value.includes('TEST edited through existing UI'),
    'edited markdown'
  );
  await ui.waitRead(
    "!document.querySelector('#skill-description')&&document.body.innerText.includes('TEST edited through existing UI')",
    'edited result visible'
  );
  proof.editAppliedScreenshot = await screenshot('ui-skills-edit-applied.png');
  await escape();
  await clickCard('test-ui-created');

  const original = await lstat(created),
    originalSnapshot = await snapshot(created);
  const trashObservations: Record<string, unknown>[] = [];
  let replacementCreated = false;
  let observationError: unknown;
  const observer = watch(join(root, 'claude/skills'), (_event, name) => {
    if (name !== 'test-ui-created' || existsSync(created) || replacementCreated) return;
    try {
      mkdirSync(created, { mode: 0o700 });
      replacementCreated = true;
      const directories = readdirSync(join(root, 'claude/skills')).filter((name) =>
        /^\._desktop-skill-[a-f0-9]{64}$/.test(name)
      );
      assert.ok(directories.length <= 8);
      for (const name of directories) {
        const path = join(root, 'claude/skills', name, 'original');
        try {
          const staged = lstatSync(path);
          if (staged.dev !== original.dev || staged.ino !== original.ino) continue;
          const bytes = readFileSync(join(path, 'SKILL.md'));
          assert.equal(digest(bytes), originalSnapshot['SKILL.md']);
          trashObservations.push({
            observedOriginalStage: path,
            dev: staged.dev,
            ino: staged.ino,
            markdownSha256: digest(bytes),
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      trashObservations.push({
        observedOriginalAbsent: true,
        replacementCreatedAtMs: performance.now(),
      });
    } catch (error) {
      observationError = error;
    }
  });
  try {
    await ui.click('[role="dialog"] button', 'existing Delete action', 'Delete');
    await ui.click('[role="alertdialog"] button', 'confirm OS Trash exactly once', 'Delete Skill');
    const rows = await readUntil(
      journal,
      (rows) =>
        rows.some(
          (row) =>
            row.kind === 'skill.mutation' && row.action === 'trash' && row.phase === 'completed'
        ),
      'original native Trash completion'
    );
    const completed = rows.filter(
      (row) => row.kind === 'skill.mutation' && row.action === 'trash' && row.phase === 'completed'
    );
    assert.equal(completed.length, 1);
    const staged = object(completed[0]!.trash);
    assert.equal(staged.dev, original.dev);
    assert.equal(staged.ino, original.ino);
    assert.equal(existsSync(String(staged.path)), false);
    assert.equal(completed[0]!.resourceHeld, false);
    await readUntil(async () => replacementCreated, Boolean, 'replacement at old original name');
    assert.equal(
      observationError,
      undefined,
      'owned stage observer completed without losing original identity'
    );
    assert.deepEqual(await snapshot(created), { '/': 'directory' });
    proof.nativeTrash = {
      completed: completed[0],
      originalSnapshot,
      replacementSurvived: true,
      trashObservations,
      callbackEvidence:
        'Host completed requires original Main nativeCompleted=true plus staged absence; OS Trash destination inventory was not read',
    };
  } finally {
    observer.close();
  }
  await ui.waitRead(
    "!document.querySelector('[role=alertdialog]')&&!document.body.innerText.includes('Deleting...')",
    'Trash result visible'
  );
  proof.trashCompletedScreenshot = await screenshot('ui-skills-trash-completed.png');

  await escape();
  await clickCard('test-ui-held');
  for (let attempt = 0; attempt < 2; attempt++) {
    await ui.click('[role="dialog"] button', 'held Delete attempt ' + attempt, 'Delete');
    await ui.click(
      '[role="alertdialog"] button',
      'held original intent confirm ' + attempt,
      'Delete Skill'
    );
    await waitText('original skill change is unconfirmed');
    assert.deepEqual(await snapshot(held), heldBefore);
    const rows = await journal();
    assert.deepEqual(
      rows.find((row) => row.commandId === fixture.unknownCommandId),
      unknownBefore
    );
  }
  proof.unknownHeldScreenshot = await screenshot('ui-skills-unknown-held.png');
  await escape();

  await ui.click('button', 'open import before context replacement', 'Import');
  await fill('#skill-import-source', source);
  await fill('#skill-import-folder', 'test-ui-stale-context');
  await ui.click(
    '[role="dialog"] button',
    'review before original context replacement',
    'Review And Import'
  );
  await waitText('Review skill changes');
  const beforeContextRows = await journal();
  step({
    fixtureStage:
      'existing config.update replaces local ServiceContext; no native picker or invented context UI',
  });
  await cdp.evaluate(
    `window.electronAPI.config.update('general',{claudeRootPath:${desktopJsLiteral(join(root, 'claude'))}})`
  );
  await ui.click('[role="dialog"] button', 'confirm stale original context once', 'Import Skill');
  await waitText('Review the original skill import before saving');
  assert.equal(existsSync(join(root, 'claude/skills/test-ui-stale-context')), false);
  assert.deepEqual(await journal(), beforeContextRows);
  proof.staleContextScreenshot = await screenshot('ui-skills-stale-context.png');
  proof.contextBoundary =
    'Real original local ServiceContext replacement through existing config API while the actual review stays open; existing confirm cannot reuse old import grant';
  const finalRows = await journal();
  assert.equal(
    finalRows.length,
    5,
    'one original held intent plus four actual completed UI mutations'
  );
  proof.finalJournal = finalRows;
  proof.status = 'PASS';
  proof.visualAcceptance = 'pending screenshot inspection';
  proof.finishedAt = new Date().toISOString();
  assert.equal(digest(JSON.stringify(await snapshot(held))), digest(JSON.stringify(heldBefore)));
}
