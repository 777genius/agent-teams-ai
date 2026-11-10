import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
/** Hover first, then dispatch exactly one click only after the exact Task card stops moving. */
export async function clickStableDesktopReviewTask(
  cdp: UiCdpPort,
  options: {
    taskId: string;
    assertOwnedRenderer(): void;
    step(value: Record<string, unknown>): void;
  }
): Promise<void> {
  assert.match(options.taskId, /^[A-Za-z0-9_-]+$/);
  const ui = createDesktopUiControls(cdp, options),
    selector = `.kanban-task-card[data-task-id="${options.taskId}"]`;
  await cdp.send('Page.bringToFront');
  await ui.scrollTo(selector, 'original Task card before hover');
  const expression = `(() => {
    const card=document.querySelector(${JSON.stringify(selector)});if(!card)return null;
    const r=card.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
    if(!r.width||!r.height||!hit||!card.contains(hit)||hit.closest('button'))return null;
    return {x,y,width:r.width,height:r.height,taskId:card.dataset.taskId,hitTaskId:hit.closest('.kanban-task-card')?.dataset.taskId};
  })()`;
  let point = record(await ui.waitRead(expression, 'exact visible Task card hit before hover'));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  let stable = 0;
  for (let sample = 0; sample < 15; sample++) {
    await new Promise<void>((done) => setTimeout(done, 100));
    options.assertOwnedRenderer();
    const next = record(await ui.waitRead(expression, 'exact hovered Task card hit'));
    stable = JSON.stringify(point) === JSON.stringify(next) ? stable + 1 : 0;
    point = next;
    if (stable >= 3) break;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  }
  assert.ok(stable >= 3, 'Task card geometry stabilizes after hover before its only click');
  assert.equal(point.taskId, options.taskId);
  assert.equal(point.hitTaskId, options.taskId);
  options.step({
    action: 'mouseClick',
    label: 'open original Task detail',
    selector,
    target: point,
    stableGeometrySamples: stable,
    state: 'attempted',
  });
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
}

/** Shared original Task Changes navigation and hunk controls; DOM reads never dispatch actions. */
export function createDesktopReviewHunkControls(
  cdp: UiCdpPort,
  options: {
    taskId: string;
    subject: string;
    fileLabel: string;
    assertOwnedRenderer(): void;
    step(value: Record<string, unknown>): void;
  }
) {
  const ui = createDesktopUiControls(cdp, options);
  const historySelector = 'button[aria-label^="Review history:"]';
  const waitHistory = (undo: number, redo: number) =>
    ui.waitRead(
      `(() => {
    const rows=[...document.querySelectorAll(${JSON.stringify(historySelector)})];
    return rows.length===1&&rows[0].getAttribute('aria-label')===${JSON.stringify(`Review history: ${undo} undo, ${redo} redo; saved`)};
  })()`,
      'exact durable review history position'
    );
  const openChanges = async () => {
    if (
      !(await cdp.evaluate(
        `Boolean(document.querySelector('.kanban-task-card[data-task-id="'+CSS.escape(${JSON.stringify(options.taskId)})+'"]'))`
      ))
    )
      await ui.clickSidebar(options.subject);
    await clickStableDesktopReviewTask(cdp, options);
    await ui.waitRead(
      `Boolean(document.querySelector('[role="dialog"]'))&&[...document.querySelectorAll('[role="dialog"] h2')].some(node=>node.textContent.includes(${JSON.stringify(options.subject)}))`,
      'exact original Task detail opens'
    );
    const section =
      '[role="dialog"] section:has(svg.lucide-file-diff) > div > button[aria-label="Expand section"]';
    await ui.scrollTo(section, 'Task Changes section');
    await ui.click(section, 'expand original Changes section');
    const file = `[role="dialog"] [role="button"][aria-label=${JSON.stringify(options.fileLabel)}]`;
    await ui.scrollTo(file, 'ledger-backed Task change');
    await ui.click(file, 'open original Changes for exact Task file');
    await ui.waitRead(
      `Boolean(document.querySelector('button[aria-label="Close Changes"]'))&&
      [...document.querySelectorAll('h2')].some(e=>e.textContent.includes(${JSON.stringify(options.subject)}))&&Boolean(document.querySelector('.cm-editor'))`,
      'original Changes ready for captured Task'
    );
  };
  const hoverLine = async (text: string) => {
    await ui.scrollTo('.cm-line', 'visible exact changed line', text);
    const point = record(
      await ui.waitRead(
        `(() => {
      const rows=[...document.querySelectorAll('.cm-line')].filter(e=>e.textContent===${JSON.stringify(text)});
      if(rows.length!==1)return null;const e=rows[0],r=e.getBoundingClientRect();
      const x=Math.min(innerWidth-40,r.x+Math.min(r.width/2,160)),y=r.y+r.height/2;
      const hit=document.elementFromPoint(x,y);return hit&&e.contains(hit)?{x,y}:null;
    })()`,
        'hoverable original changed line'
      )
    );
    options.assertOwnedRenderer();
    options.step({ action: 'mouseMoved', line: text, point });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...point,
    });
  };
  return { ui, openChanges, hoverLine, waitHistory, historySelector };
}

/** Read the existing canonical review snapshots, without inventing another persistence owner. */
export async function readDesktopReviewDecisions(root: string): Promise<Record<string, unknown>[]> {
  const directory = join(root, 'hoststore/teams/test-desktop-backend/review-decisions');
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  assert.ok(entries.length <= 256);
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  assert.ok(files.length <= 64);
  return Promise.all(
    files
      .sort((a, b) => join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name)))
      .map(async (entry) => {
        const path = join(entry.parentPath, entry.name),
          bytes = await readFile(path);
        assert.ok(bytes.length <= 2 * 1024 * 1024);
        return {
          path,
          sha256: await fileDigest(path),
          value: record(JSON.parse(bytes.toString('utf8'))),
        };
      })
  );
}

/** Hover and remeasure the original History trigger, then one ordinary click. */
export async function openDesktopReviewHistory(
  cdp: UiCdpPort,
  options: { assertOwnedRenderer(): void; step(value: Record<string, unknown>): void }
): Promise<void> {
  const ui = createDesktopUiControls(cdp, options);
  await cdp.send('Page.bringToFront');
  const state = `(() => {
    const rows=[...document.querySelectorAll('button[aria-label^="Review history:"]')].filter(e=>{
      const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&!e.disabled;
    });
    if(rows.length!==1)return null;
    const e=rows[0],r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
    if(!hit||!(hit===e||e.contains(hit)))return null;
    return {x,y,width:r.width,height:r.height,expanded:e.getAttribute('aria-expanded'),
      label:e.getAttribute('aria-label'),focused:document.activeElement===e};
  })()`;
  let point = record(await ui.waitRead(state, 'exact hit-tested original History trigger'));
  assert.ok(point.expanded === 'false' || point.expanded === 'true');
  if (point.expanded === 'false') {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    let stable = 0;
    for (let sample = 0; sample < 15 && stable < 3; sample++) {
      await new Promise<void>((done) => setTimeout(done, 100));
      const next = record(await ui.waitRead(state, 'hovered original History geometry'));
      assert.equal(next.expanded, 'false');
      stable = ['x', 'y', 'width', 'height', 'label'].every((key) => next[key] === point[key])
        ? stable + 1
        : 0;
      point = next;
      if (stable === 0)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    }
    assert.equal(stable, 3, 'exact History hit target stable before its one click');
    options.assertOwnedRenderer();
    options.step({
      action: 'mouseClick',
      label: 'open original History after stable hover',
      target: point,
      stableGeometrySamples: stable,
      state: 'attempted',
    });
    for (const type of ['mousePressed', 'mouseReleased'])
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x: point.x,
        y: point.y,
        button: 'left',
        clickCount: 1,
      });
  }
  await ui.waitRead(
    `(${state}).expanded==='true'&&/undo stack/i.test(document.body.innerText)`,
    'original History expanded after stable hover'
  );
  options.step({
    observation: 'passive History input delivery',
    value: await cdp.evaluate(
      '({focused:document.hasFocus(),active:document.activeElement?.getAttribute("aria-label"),events:window.__TEST_desktopInputEvents??[]})'
    ),
  });
}
