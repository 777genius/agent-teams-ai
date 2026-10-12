import assert from 'node:assert/strict';
import { delay, until, type Desktop } from './runtime.ts';
import type { Snapshot } from '../../../src/features/task-folders/core/domain/folders.ts';

export const selectors = {
  toggle: '[data-testid="task-folders-toggle"]',
  panel: '[data-testid="task-folders-panel"]',
  create: '[data-testid="task-folders-new-folder"]',
  tree: '[data-testid="task-folders-tree"]',
  archived: '[data-testid="task-folders-show-archived"]',
  sidebar: '#sidebar-tasks-panel',
  folderHandle: '[data-testid="task-folder-drag-handle"]',
  taskHandle: '[data-testid="sidebar-task-drag-handle"]',
};
export const el = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`;
export const label = (
  text: string,
  root = 'document',
  roles = 'button,[role="button"],[role="menuitem"],[role="option"]'
) =>
  `Array.from(${root}.querySelectorAll(${JSON.stringify(roles)})).find(e=>e.getAttribute('aria-label')===${JSON.stringify(text)} || e.textContent?.trim()===${JSON.stringify(text)})`;
export const folderRow = (id: string) => el(`${selectors.tree} [data-folder-id="${id}"]`);
export const taskRow = (team: string, id: string, root = selectors.tree) =>
  `Array.from(${el(root)}.querySelectorAll('[data-task-key]')).find(e=>e.getAttribute('data-task-key')===${JSON.stringify(JSON.stringify([team, id]))})`;
export interface Point {
  x: number;
  y: number;
}
const TARGET_PRESENCE_TIMEOUT_MS = 5000;
const TREE_NAVIGATION_TIMEOUT_MS = 30_000;
const boundedPresence = async (probe: () => Promise<boolean>, timeout: number) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await delay(50);
  }
  return probe();
};
export class UI {
  dragEvidence: unknown[] = [];
  constructor(readonly desktop: Desktop) {}
  get cdp() {
    assert(this.desktop.cdp);
    return this.desktop.cdp;
  }
  async value<T>(expression: string): Promise<T> {
    return (await this.cdp.evaluate(expression)) as T;
  }
  async wait(expression: string, name: string, timeout?: number) {
    await until(() => this.value(`(async()=>Boolean(await (${expression})))()`), name, timeout);
  }
  async locate(expression: string) {
    const exists = () =>
      this.value<boolean>(`(() => {try{return !!(${expression});}catch{return false;}})()`);
    if (await exists()) return;
    if (!expression.includes(selectors.tree)) {
      if (await boundedPresence(exists, TARGET_PRESENCE_TIMEOUT_MS)) return;
      throw new Error(
        `Missing selector after ${TARGET_PRESENCE_TIMEOUT_MS}ms target presence wait: ${expression}`
      );
    }
    await until(
      () => this.value<boolean>(`!!${el(selectors.tree)}`),
      'virtual tree presence',
      TARGET_PRESENCE_TIMEOUT_MS
    );
    // Navigate the real virtual scroll container, including during an intercepted native drag.
    await this.cdp.evaluate(`${el(selectors.tree)}.scrollTop=0`);
    await this.cdp.evaluate('new Promise(resolve => requestAnimationFrame(() => resolve()))');
    if (await exists()) return;
    const steps = await this.value<number>(
      `Math.ceil(${el(selectors.tree)}.scrollHeight / Math.max(100,${el(selectors.tree)}.clientHeight/2))+2`
    );
    const deadline = Date.now() + TREE_NAVIGATION_TIMEOUT_MS;
    for (let step = 0; step < steps && Date.now() < deadline; step++) {
      await this.cdp.evaluate(
        `${el(selectors.tree)}.scrollTop+=Math.max(100,${el(selectors.tree)}.clientHeight/2)`
      );
      await this.cdp.evaluate('new Promise(resolve => requestAnimationFrame(() => resolve()))');
      if (await exists()) return;
    }
    throw new Error('Missing selector after virtual tree navigation: ' + expression);
  }
  async point(expression: string, fraction = 0.5): Promise<Point> {
    await this.locate(expression);
    const deadline = Date.now() + 5000;
    let reason = 'Missing/hidden selector';
    while (Date.now() < deadline) {
      // Reacquire after scrolling/layout/portal transitions; geometry and hit belong to one sample.
      const result = await this.value<{ point?: Point; reason: string }>(`(() => {
        let e;try{e=${expression};}catch{return {reason:'Missing/hidden selector'};}
        if(!e)return {reason:'Missing/hidden selector'};
        e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();
        if(r.width<=0 || r.height<=0 || !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))
          return {reason:'Missing/hidden selector'};
        const p={x:r.x+r.width/2,y:r.y+r.height*${fraction}};
        if(!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x<0 || p.y<0 ||
          p.x>=innerWidth || p.y>=innerHeight)return {reason:'Target obscured/offscreen'};
        const h=document.elementFromPoint(p.x,p.y);
        return h && (e===h || e.contains(h)) ? {point:p,reason:''} : {reason:'Target obscured'};
      })()`);
      if (result.point) return result.point;
      reason = result.reason;
      await delay(50);
    }
    throw new Error(`${reason} after 5000ms hit readiness wait: ${expression}`);
  }
  async move(point: Point, buttons = 0) {
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...point,
      button: buttons ? 'left' : 'none',
      buttons,
    });
  }
  async click(expression: string) {
    const p = await this.point(expression);
    await this.move(p);
    for (const type of ['mousePressed', 'mouseReleased'])
      await this.cdp.send('Input.dispatchMouseEvent', {
        type,
        ...p,
        button: 'left',
        clickCount: 1,
      });
  }
  async key(key: string, code = key, modifiers = 0) {
    const vk: Record<string, number> = {
      Enter: 13,
      Escape: 27,
      Tab: 9,
      ArrowDown: 40,
      ArrowUp: 38,
      Home: 36,
      F2: 113,
      a: 65,
    };
    for (const type of ['rawKeyDown', 'keyUp'])
      await this.cdp.send('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        modifiers,
        windowsVirtualKeyCode: vk[key] ?? 0,
        nativeVirtualKeyCode: vk[key] ?? 0,
      });
  }
  async fill(expression: string, text: string) {
    await this.click(expression);
    await this.key('a', 'KeyA', 2);
    await this.cdp.send('Input.insertText', { text });
  }
  async menu(row: string, action?: string) {
    await this.click(label('Folder or task actions', row));
    await this.wait('document.querySelector(\'[role="menu"]\')', 'portaled action menu');
    if (action) {
      await this.click(label(action, 'document', '[role="menuitem"]'));
      await this.wait(
        '!document.querySelector(\'[role="menu"]\')',
        'deferred action menu disposal',
        TARGET_PRESENCE_TIMEOUT_MS
      );
    }
  }
  async expand(id: string) {
    await this.locate(folderRow(id));
    const button = label('Expand folder', folderRow(id));
    if (await this.value(`!!(${button})`)) await this.click(button);
  }
  async accessibility(expression: string) {
    const result = (await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: false,
    })) as { result: { objectId?: string } };
    const objectId = result.result.objectId;
    assert(objectId, 'Missing accessibility target: ' + expression);
    try {
      const { node } = (await this.cdp.send('DOM.describeNode', { objectId })) as {
        node: { backendNodeId: number };
      };
      const { nodes } = (await this.cdp.send('Accessibility.getPartialAXTree', {
        backendNodeId: node.backendNodeId,
        fetchRelatives: false,
      })) as {
        nodes: {
          ignored: boolean;
          role?: { value: string };
          name?: { value: string };
          description?: { value: string };
        }[];
      };
      assert(nodes[0] && !nodes[0].ignored, 'Accessibility target is ignored');
      return {
        role: nodes[0].role?.value,
        name: nodes[0].name?.value,
        description: nodes[0].description?.value,
      };
    } finally {
      await this.cdp.send('Runtime.releaseObject', { objectId });
    }
  }
  async snapshot(): Promise<Snapshot> {
    return await this.value('JSON.parse(localStorage.getItem("taskFolders:v1"))');
  }
  async persisted(predicate: (s: Snapshot) => boolean, label: string) {
    await until(async () => predicate(await this.snapshot()), 'persisted ' + label);
  }
  async open() {
    if (!(await this.value(`!!${el(selectors.panel)}`))) await this.click(el(selectors.toggle));
    await this.wait(el(selectors.tree), 'folder tree');
  }
  async close() {
    await this.click(label('Close', el(selectors.panel)));
    await this.wait(`!${el(selectors.panel)}`, 'panel closed');
  }
  async create(name: string, parent?: string) {
    if (parent) await this.menu(folderRow(parent), 'New subfolder');
    else await this.click(el(selectors.create));
    await this.wait('document.querySelector(\'[role="dialog"] input\')', 'new folder dialog');
    await this.fill(el('[role="dialog"] input'), name);
    await this.key('Enter');
    await this.persisted((s) => s.folders.some((f) => f.name === name), 'folder creation ' + name);
    return (await this.snapshot()).folders.find((f) => f.name === name)!.id;
  }
  async unfocus() {
    // Transfer both pointer and keyboard focus outside with trusted native input.
    const target = await this.value<Point | null>(`(() => {
      const panel=${el(selectors.panel)};
      const interactive='button,[role="button"],input,textarea,select,a,[tabindex],[role="treeitem"],[data-task-key],[data-folder-id],[role="dialog"],[role="menu"]';
      for(let y=1;y<innerHeight;y+=Math.max(8,Math.floor(innerHeight/20)))
        for(let x=1;x<innerWidth;x+=Math.max(8,Math.floor(innerWidth/20))) {
          const hit=document.elementFromPoint(x,y);
          if(hit && !panel?.contains(hit) && !hit.closest(interactive)) return {x,y};
        }
      return null;
    })()`);
    assert(target, 'No noninteractive target outside the folder panel for trusted focus transfer');
    await this.move(target);
    for (const type of ['mousePressed', 'mouseReleased'])
      await this.cdp.send('Input.dispatchMouseEvent', {
        type,
        ...target,
        button: 'left',
        clickCount: 1,
      });
    await this.wait(
      `!${el(selectors.panel)}?.contains(document.activeElement)`,
      'focus transferred outside folder panel'
    );
  }
  async beginDrag(
    source: string,
    expectedTask?: { teamName: string; taskId: string },
    expectPanel = true
  ) {
    this.desktop.takeDrag();
    await this.cdp.evaluate(`(() => {window.__taskFoldersE2EDragStarts=[];
      if(!window.__taskFoldersE2EObserving){window.__taskFoldersE2EObserving=true;
        document.addEventListener('dragstart',e=>window.__taskFoldersE2EDragStarts.push({trusted:e.isTrusted,handle:e.target?.getAttribute('data-testid')}),true);}})()`);
    const start = await this.point(source);
    await this.move(start);
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...start,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    for (let i = 1; i <= 8; i++) {
      await this.move({ x: start.x - i * 5, y: start.y + i }, 1);
      await delay(30);
    }
    let data: Record<string, unknown> | undefined;
    await until(
      async () => {
        data = this.desktop.takeDrag();
        return !!data;
      },
      'Chromium native drag interception',
      5000
    );
    assert(data, 'No actual native mouse drag');
    const observed = await this.value<{ trusted: boolean; handle: string }[]>(
      'window.__taskFoldersE2EDragStarts'
    );
    assert(
      observed.some(
        (e) =>
          e.trusted && ['task-folder-drag-handle', 'sidebar-task-drag-handle'].includes(e.handle)
      ),
      'Trusted native dragstart missing'
    );

    if (expectedTask) {
      const item = (data.items as { mimeType: string; data: string }[]).find(
        (i) => i.mimeType === 'application/x-agent-teams-task-v1'
      );
      assert(item, 'Native task MIME missing');
      assert.deepEqual(JSON.parse(item.data), { version: 1, identity: expectedTask });
    }
    this.dragEvidence.push({
      source,
      nativeInput: true,
      intercepted: data,
      observedDragStarts: observed,
      at: new Date().toISOString(),
    });
    if (expectPanel) await this.wait(el(selectors.panel), 'native drag opened panel');
    return data;
  }
  async dragOver(data: Record<string, unknown>, point: Point, enter = false) {
    await this.move(point, 1);
    await this.cdp.send('Input.dispatchDragEvent', {
      type: enter ? 'dragEnter' : 'dragOver',
      ...point,
      data,
    });
  }
  async finishDrag(data: Record<string, unknown>, point: Point, cancel = false) {
    if (cancel) {
      await this.cdp.send('Input.dispatchDragEvent', { type: 'dragCancel', ...point, data });
      await this.cdp.send('Input.cancelDragging');
      await this.key('Escape');
    } else {
      await this.dragOver(data, point);
      await this.cdp.send('Input.dispatchDragEvent', { type: 'drop', ...point, data });
    }
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...point,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await this.cdp.send('Input.cancelDragging');
  }
  async drag(
    source: string,
    target: string,
    fraction = 0.5,
    expectedTask?: { teamName: string; taskId: string }
  ) {
    const data = await this.beginDrag(source, expectedTask);
    const point = await this.point(target, fraction);
    await this.dragOver(data, point, true);
    await delay(100);
    await this.finishDrag(data, point);
  }
}
