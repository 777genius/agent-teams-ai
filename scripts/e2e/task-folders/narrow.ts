import assert from 'node:assert/strict';
import { delay, type Fixture } from './runtime.ts';
import { el, folderRow, label, selectors, taskRow, type UI } from './ui.ts';

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
    const source = `${taskRow(f.team, 'c', selectors.sidebar)}.querySelector(${JSON.stringify(selectors.taskHandle)})`;
    const before = await ui.snapshot();
    const drag = await ui.beginDrag(source, { teamName: f.team, taskId: 'c' }, false);
    assert(
      await ui.value(`!${el(selectors.panel)} && !document.querySelector('[role="dialog"]')`),
      'Narrow drag auto-opened modal'
    );
    await ui.finishDrag(drag, { x: 10, y: 80 }, true);
    const deadline = Date.now() + 2200;
    while (Date.now() < deadline) {
      assert(
        await ui.value(`!${el(selectors.panel)} && !document.querySelector('[role="dialog"]')`),
        'Drag cancellation opened/trapped modal'
      );
      await delay(50);
    }
    assert.deepEqual(await ui.snapshot(), before, 'Narrow cancelled drag changed storage');
    await ui.value(`${el(selectors.toggle)}.focus()`);
    await ui.key('Tab');
    assert(
      await ui.value(
        `document.activeElement !== ${el(selectors.toggle)} && !document.activeElement.closest('[role="dialog"]')`
      ),
      'Narrow drag trapped focus'
    );
    await ui.open();
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
    evidence.push({ width, geometry, accessibility: ax, nativeDragOpenedModal: false });
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
