import assert from 'node:assert/strict';
import { cardLayoutScenarios } from './mode-layout.ts';
import { delay, type Fixture } from './runtime.ts';
import { el, folderRow, label, selectors, type UI } from './ui.ts';

export async function narrowViewport(
  ui: UI,
  f: Fixture,
  screenshot: (name: string) => Promise<void>
) {
  const evidence = [];
  await ui.close();
  for (const width of [360, 440]) {
    await ui.cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 750,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await ui.wait(
      `${el(selectors.toggle)}.getBoundingClientRect().right <= ${width}`,
      'narrow sidebar resized'
    );
    await ui.assertFolderMode(false);
    await ui.attemptDisabledTaskDrag(f.team, 'c');
    const before = await ui.snapshot();
    await ui.open();
    await ui.expand(f.parent);
    await ui.expand(f.nested);
    // Narrow mode is modal: exercise a real tree handle inside its active focus scope.
    const source = `${folderRow(f.parent)}.querySelector(${JSON.stringify(selectors.folderHandle)})`;
    const drag = await ui.beginDrag(source);
    await ui.finishDrag(drag, { x: 10, y: 80 }, true);
    await delay(250);
    await ui.assertFolderMode(true);
    assert.deepEqual(await ui.snapshot(), before, 'Narrow cancelled drag changed storage');
    const dialog = `${el(selectors.panel)}.closest('[role="dialog"]')`;
    await ui.wait(`${dialog}?.getAttribute('aria-modal') === 'true'`, 'manual accessible modal');
    const ax = await ui.accessibility(dialog);
    assert.equal(ax.role, 'dialog');
    assert(ax.name?.trim(), 'Folder management dialog has no accessible name');
    await ui.wait(`${dialog}.contains(document.activeElement)`, 'manual modal focus');
    const geometry = await ui.value<{
      left: number;
      right: number;
      top: number;
      bottom: number;
      treeWidth: number;
      overflow: number;
      controlsBounded: boolean;
    }>(`(() => {
      const d=${dialog}, p=${el(selectors.panel)}, t=${el(selectors.tree)}, r=d.getBoundingClientRect();
      const controls=Array.from(p.firstElementChild.querySelectorAll('button,[role="checkbox"]'));
      return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,treeWidth:t.clientWidth,
        overflow:Math.max(d.scrollWidth-d.clientWidth,p.scrollWidth-p.clientWidth,t.scrollWidth-t.clientWidth),
        controlsBounded:controls.every(e=>{const b=e.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight;})};})()`);
    assert(
      geometry.left >= 0 && geometry.right <= width && geometry.top >= 0 && geometry.bottom <= 750,
      JSON.stringify(geometry)
    );
    assert(
      geometry.treeWidth >= 240 && geometry.overflow <= 1 && geometry.controlsBounded,
      'Unusable/offscreen modal content: ' + JSON.stringify(geometry)
    );
    // Exercise the real nested management dialog and its save, then remove the test folder.
    const created = await ui.create('Narrow manual ' + width);
    await ui.locate(folderRow(created));
    await ui.menu(folderRow(created), 'Delete folder');
    const confirmation = `Array.from(document.querySelectorAll('[role="dialog"]')).find(d=>!d.querySelector(${JSON.stringify(selectors.panel)}))`;
    await ui.wait(confirmation, 'narrow delete confirmation');
    await ui.click(label('Delete folder', confirmation));
    await ui.wait(`!(${confirmation})`, 'narrow confirmation dismissed');
    await ui.persisted((s) => !s.folders.some((folder) => folder.id === created), 'narrow delete');
    const cardGeometry = await cardLayoutScenarios(ui, f.team, 'a', false);
    await screenshot('narrow-' + width);
    await ui.key('Escape');
    await ui.wait(
      `!${el(selectors.panel)} && !document.querySelector('[role="dialog"]')`,
      'Escape closes manual modal'
    );
    await ui.open();
    await ui.close();
    await ui.wait(`!document.querySelector('[role="dialog"]')`, 'Close button closes manual modal');
    await ui.unfocus();
    await delay(2200);
    assert(await ui.value(`!${el(selectors.panel)}`), 'Fallback reopened after close');
    await ui.assertFolderMode(false);
    evidence.push({ width, geometry, cardGeometry, accessibility: ax, disabledModeCannotDrag: true });
  }
  await ui.cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 850,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await ui.open();
  return evidence;
}
