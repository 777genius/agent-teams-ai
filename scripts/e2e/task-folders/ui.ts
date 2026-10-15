import assert from 'node:assert/strict';
import { delay, until, type Desktop } from './runtime.ts';
import type { Snapshot } from '../../../src/features/task-folders/core/domain/folders.ts';

export const selectors = {
  toggle: '[data-testid="task-folders-toggle"]',
  panel: '[data-testid="task-folders-panel"]',
  create: '[data-testid="task-folders-new-folder"]',
  newFolderName: '[role="dialog"] input[aria-label="Folder name"]',
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
export const folderRow = (id: string) =>
  `Array.from(${el(selectors.tree)}?.querySelectorAll('[data-folder-id]') ?? []).find(e=>e.getAttribute('data-folder-id')===${JSON.stringify(id)})`;
export const taskRow = (team: string, id: string, root = selectors.tree) =>
  `Array.from(${el(root)}.querySelectorAll('[data-task-key]')).find(e=>e.getAttribute('data-task-key')===${JSON.stringify(JSON.stringify([team, id]))})`;
export const taskKeyData = (team: string, id: string) => JSON.stringify([team, id]);
// Helper expressions embed the selector through JSON.stringify, so the raw
// selector text alone does not identify generated virtual-tree targets.
const escapedTreeSelector = JSON.stringify(selectors.tree).slice(1, -1);
const isTreeTargetExpression = (expression: string) =>
  expression.includes(selectors.tree) || expression.includes(escapedTreeSelector);
export interface Point {
  x: number;
  y: number;
}
export interface FolderPoint extends Point {
  folderId: string;
  hitFolderId: string | null;
  dragTargetHighlighted: boolean;
}
export interface DragEventObservation {
  type: 'dragenter' | 'dragover';
  isTrusted: boolean;
  clientX: number;
  clientY: number;
  folderId: string | null;
  insideTree: boolean;
}
export interface NativeDragEvidence {
  source: string;
  nativeInput: boolean;
  intercepted: Record<string, unknown>;
  observedDragStarts: { trusted: boolean; handle: string }[];
  at: string;
  dragEvents: DragEventObservation[];
}
interface PointSample extends Partial<FolderPoint> {
  point?: Point;
  reason: string;
}
const TARGET_PRESENCE_TIMEOUT_MS = 5000;
const POINT_READINESS_TIMEOUT_MS = 5000;
const TREE_NAVIGATION_TIMEOUT_MS = 30_000;
const NATIVE_DRAGOVER_RETRY_DEADLINE_MS = 2000;
const NATIVE_DRAGOVER_MAX_RETRIES = 8;
const NATIVE_DRAGOVER_FRAME_LIMIT_MS = 500;
const boundedPresence = async (probe: () => Promise<boolean>, timeout: number) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await delay(50);
  }
  return probe();
};
type RuntimeCallArgument = { value: unknown } | { unserializableValue: 'undefined' };
export class UI {
  dragEvidence: NativeDragEvidence[] = [];
  constructor(readonly desktop: Desktop) {}
  get cdp() {
    assert(this.desktop.cdp);
    return this.desktop.cdp;
  }
  async value<T>(expression: string): Promise<T> {
    return (await this.cdp.evaluate(expression)) as T;
  }
  private async boundedValue<T>(expression: string, timeout: number, name: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} exceeded ${timeout}ms browser deadline`)), timeout);
    });
    try {
      return await Promise.race([this.value<T>(expression), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async awaitBrowserFrame(name: string) {
    await this.boundedValue(
      `new Promise(resolve=>{const done=()=>resolve(true);requestAnimationFrame(done);setTimeout(done,250);})`,
      500,
      name
    );
  }
  async callFunction<T>(functionDeclaration: string, args: readonly unknown[] = []): Promise<T> {
    assert.equal(
      functionDeclaration,
      functionDeclaration.trim(),
      'Runtime.callFunctionOn function declaration must be static and normalized'
    );
    const target = (await this.cdp.send('Runtime.evaluate', {
      expression: 'globalThis',
      returnByValue: false,
    })) as { result: { objectId?: string } };
    const objectId = target.result.objectId;
    assert(objectId, 'Missing globalThis Runtime.callFunctionOn target');
    try {
      const callArguments = args.map<RuntimeCallArgument>((value) =>
        value === undefined ? { unserializableValue: 'undefined' } : { value }
      );
      assert(
        callArguments.every(
          (argument) =>
            (Object.hasOwn(argument, 'value') && !('unserializableValue' in argument)) ||
            (!Object.hasOwn(argument, 'value') && 'unserializableValue' in argument)
        ),
        'Runtime.callFunctionOn arguments must be structured data'
      );
      const result = (await this.cdp.send('Runtime.callFunctionOn', {
        functionDeclaration,
        objectId,
        arguments: callArguments,
        returnByValue: true,
        awaitPromise: true,
      })) as { result: { value?: T }; exceptionDetails?: unknown };
      assert(
        !result.exceptionDetails,
        'Runtime.callFunctionOn failed: ' + JSON.stringify(result.exceptionDetails)
      );
      return result.result.value as T;
    } finally {
      await this.cdp.send('Runtime.releaseObject', { objectId });
    }
  }
  async waitFunction(
    functionDeclaration: string,
    args: readonly unknown[],
    name: string,
    timeout?: number
  ) {
    await until(() => this.callFunction<boolean>(functionDeclaration, args), name, timeout);
  }
  async wait(expression: string, name: string, timeout?: number) {
    const limit = timeout ?? 30_000;
    await until(
      async () => {
        try {
          return await this.boundedValue<boolean>(
            `(async()=>Boolean(await (${expression})))()`,
            Math.min(1000, Math.max(50, limit)),
            name
          );
        } catch (error) {
          if (error instanceof Error && error.message.includes('browser deadline')) return false;
          throw error;
        }
      },
      name,
      limit
    );
  }
  async locate(expression: string, deadline = Date.now() + TREE_NAVIGATION_TIMEOUT_MS) {
    const exists = () =>
      this.value<boolean>(`(() => {try{return !!(${expression});}catch{return false;}})()`);
    if (await exists()) return;
    if (!isTreeTargetExpression(expression)) {
      if (await boundedPresence(exists, TARGET_PRESENCE_TIMEOUT_MS)) return;
      throw new Error(
        `Missing selector after ${TARGET_PRESENCE_TIMEOUT_MS}ms target presence wait: ${expression}`
      );
    }
    await until(
      () => this.value<boolean>(`!!${el(selectors.tree)}`),
      'virtual tree presence',
      Math.max(1, deadline - Date.now())
    );
    // Navigate the real virtual scroll container, including during an intercepted native drag.
    await this.cdp.evaluate(`${el(selectors.tree)}.scrollTop=0`);
    await this.awaitBrowserFrame('virtual tree navigation frame');
    if (await exists()) return;
    const steps = await this.value<number>(
      `Math.ceil(${el(selectors.tree)}.scrollHeight / Math.max(100,${el(selectors.tree)}.clientHeight/2))+2`
    );
    for (let step = 0; step < steps && Date.now() < deadline; step++) {
      await this.cdp.evaluate(
        `${el(selectors.tree)}.scrollTop+=Math.max(100,${el(selectors.tree)}.clientHeight/2)`
      );
      await this.awaitBrowserFrame('virtual tree navigation frame');
      if (await exists()) return;
    }
    throw new Error('Missing selector after virtual tree navigation: ' + expression);
  }
  async point(expression: string, fraction = 0.5): Promise<Point> {
    return (await this.pointSample(expression, fraction)).point!;
  }
  private async pointSample(expression: string, fraction = 0.5): Promise<PointSample> {
    const deadline = Date.now() + POINT_READINESS_TIMEOUT_MS;
    await this.locate(expression, deadline);
    let reason = 'Missing/hidden selector';
    while (Date.now() < deadline) {
      // Reacquire after scrolling/layout/portal transitions; geometry and hit belong to one sample.
      const result = await this.value<PointSample>(`(() => {
        let e;try{e=${expression};}catch{return {reason:'Missing/hidden selector'};}
        if(!e)return {reason:'Missing/hidden selector'};
        e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();
        if(r.width<=0 || r.height<=0 || !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))
          return {reason:'Missing/hidden selector'};
        const p={x:r.x+r.width/2,y:r.y+r.height*${fraction}};
        if(!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x<0 || p.y<0 ||
          p.x>=innerWidth || p.y>=innerHeight)return {reason:'Target obscured/offscreen'};
        const h=document.elementFromPoint(p.x,p.y);
        if(!h || (e!==h && !e.contains(h)))return {reason:'Target obscured'};
        const hit=h.closest('[data-folder-id]');
        return {
          point:p,
          reason:'',
          folderId:e.getAttribute('data-folder-id'),
          hitFolderId:hit?.getAttribute('data-folder-id') ?? null,
          dragTargetHighlighted:e.classList.contains('bg-blue-500/20'),
        };
      })()`);
      if (result.point) return result;
      reason = result.reason;
      // Virtualization can unmount the same target between acquisition and geometry.
      // Reacquire only this exact helper expression within the existing readiness deadline.
      if (isTreeTargetExpression(expression) && Date.now() < deadline) {
        try {
          await this.locate(expression, deadline);
        } catch (error) {
          if (!String(error).includes('Missing selector after virtual tree navigation')) throw error;
        }
      }
      await delay(50);
    }
    throw new Error(`${reason} after 5000ms hit readiness wait: ${expression}`);
  }
  async folderPoint(id: string, requireDragTarget = false): Promise<FolderPoint> {
    if (requireDragTarget) {
      await this.wait(
        `${folderRow(id)}?.classList.contains('bg-blue-500/20')`,
        `same-ID vendor drag-target highlight for ${id}`,
        TARGET_PRESENCE_TIMEOUT_MS
      );
    }
    // Geometry, hit identity, and vendor highlight must come from one fresh DOM sample.
    const sample = await this.pointSample(folderRow(id));
    assert.equal(sample.folderId, id, 'Folder point changed identity');
    assert.equal(sample.hitFolderId, id, 'Folder center was not the real hit target');
    if (requireDragTarget)
      assert(sample.dragTargetHighlighted, 'Vendor drag-target highlight missing for ' + id);
    return {
      ...sample.point!,
      folderId: id,
      hitFolderId: sample.hitFolderId!,
      dragTargetHighlighted: sample.dragTargetHighlighted!,
    };
  }
  async visibleFolderCenter(excludeId: string): Promise<FolderPoint> {
    const id = await this.value<string | null>(`(() => {
      const tree=${el(selectors.tree)};if(!tree)return null;
      const bounds=tree.getBoundingClientRect();
      return Array.from(tree.querySelectorAll('[data-folder-id]')).find(e=>{
        if(e.getAttribute('data-folder-id')===${JSON.stringify(excludeId)})return false;
        const r=e.getBoundingClientRect();
        if(r.top<=bounds.top+32 || r.bottom>=bounds.bottom-32)return false;
        const p={x:r.x+r.width/2,y:r.y+r.height/2};
        const h=document.elementFromPoint(p.x,p.y);
        return !!h && (h===e || e.contains(h));
      })?.getAttribute('data-folder-id') ?? null;
    })()`);
    assert(id, 'Auto-scroll exposed no real visible folder center');
    return await this.folderPoint(id);
  }
  async waitForStableScroll(): Promise<number> {
    await this.wait(
      `(async()=>{const tree=${el(selectors.tree)};if(!tree)return false;let last=tree.scrollTop;
        for(let i=0;i<2;i++){await new Promise(resolve=>requestAnimationFrame(resolve));
          if(tree.scrollTop!==last)return false;last=tree.scrollTop;}return true;})()`,
      'native center drag stopped edge scrolling across consecutive RAFs',
      TARGET_PRESENCE_TIMEOUT_MS
    );
    return await this.value<number>(`${el(selectors.tree)}.scrollTop`);
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
      ' ': 32,
      Spacebar: 32,
    };
    const isNativeActivation = key === 'Enter' || key === ' ' || key === 'Spacebar';
    const text = key === 'Enter' ? '\r' : key === ' ' || key === 'Spacebar' ? ' ' : undefined;
    for (const type of [isNativeActivation ? 'keyDown' : 'rawKeyDown', 'keyUp'])
      await this.cdp.send('Input.dispatchKeyEvent', {
        type,
        key,
        code: key === 'Spacebar' ? 'Space' : code,
        modifiers,
        ...(text ? { text, unmodifiedText: text } : {}),
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
  async waitMenuClosedAndFocusRestored(row: string) {
    const trigger = label('Folder or task actions', row);
    await this.wait(
      `!document.querySelector('[role="menu"]') && document.activeElement === (${trigger})`,
      'action menu closed with default row focus restored',
      TARGET_PRESENCE_TIMEOUT_MS
    );
  }
  async waitDropFocusRestored() {
    await this.wait(
      `(async()=>{const tree=${el(selectors.tree)};const active=document.activeElement;
        if(!tree || !active || !active.matches('[role="treeitem"]') || active.getAttribute('tabindex')!=='0' || !tree.contains(active))return false;
        const frames=new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))));
        const deadline=new Promise(resolve=>setTimeout(()=>resolve(false),${TARGET_PRESENCE_TIMEOUT_MS}));
        if(!await Promise.race([frames,deadline]))return false;
        return document.activeElement===active && active.matches('[role="treeitem"]') && active.getAttribute('tabindex')==='0' && tree.contains(active);})()`,
      'vendor drop completion restored stable tree focus across consecutive RAFs',
      TARGET_PRESENCE_TIMEOUT_MS
    );
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
    await this.wait(el(selectors.newFolderName), 'labelled new folder name input');
    await this.fill(el(selectors.newFolderName), name);
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
      `(async()=>{const panel=${el(selectors.panel)};const active=document.activeElement;
        if(panel?.contains(active))return false;
        const frames=new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))));
        const deadline=new Promise(resolve=>setTimeout(()=>resolve(false),${TARGET_PRESENCE_TIMEOUT_MS}));
        if(!await Promise.race([frames,deadline]))return false;
        return document.activeElement===active && !panel?.contains(document.activeElement);})()`,
      'trusted outside focus remained outside folder panel across consecutive RAFs',
      TARGET_PRESENCE_TIMEOUT_MS
    );
  }
  async beginDrag(
    source: string,
    expectedTask?: { teamName: string; taskId: string },
    expectPanel = true
  ) {
    this.desktop.takeDrag();
    await this.cdp.evaluate(`(() => {window.__taskFoldersE2EDragStarts=[];window.__taskFoldersE2EDragEvents=[];
      if(!window.__taskFoldersE2EObserving){window.__taskFoldersE2EObserving=true;
        document.addEventListener('dragstart',e=>window.__taskFoldersE2EDragStarts.push({trusted:e.isTrusted,handle:e.target?.getAttribute('data-testid')}),true);
        const observeDrag=e=>{const target=e.target;const folder=target instanceof Element?target.closest('[data-folder-id]'):null;
          const tree=document.querySelector(${JSON.stringify(selectors.tree)});
          window.__taskFoldersE2EDragEvents.push({type:e.type,isTrusted:e.isTrusted,clientX:e.clientX,clientY:e.clientY,
            folderId:folder?.getAttribute('data-folder-id')??null,insideTree:!!tree&&(tree===target||tree.contains(target))});};
        document.addEventListener('dragenter',observeDrag,true);document.addEventListener('dragover',observeDrag,true);}})()`);
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
      dragEvents: [],
    });
    if (expectPanel) await this.wait(el(selectors.panel), 'native drag opened panel');
    return data;
  }
  private async syncDragEvents(): Promise<DragEventObservation[]> {
    const events = await this.value<DragEventObservation[]>(
      'window.__taskFoldersE2EDragEvents ?? []'
    );
    const evidence = this.dragEvidence.at(-1);
    if (evidence) evidence.dragEvents = events;
    return events;
  }
  async nativeDragEvents(): Promise<DragEventObservation[]> {
    return await this.syncDragEvents();
  }
  async assertNativeDragPair(point: Point, name: string, data: Record<string, unknown>) {
    const near = (event: DragEventObservation) =>
      event.isTrusted &&
      Math.abs(event.clientX - point.x) <= 1 &&
      Math.abs(event.clientY - point.y) <= 1;
    let events = await this.syncDragEvents();
    let over = events.filter((event) => event.type === 'dragover' && near(event));
    const deadline = Date.now() + NATIVE_DRAGOVER_RETRY_DEADLINE_MS;
    for (let attempt = 0; !over.length && attempt < NATIVE_DRAGOVER_MAX_RETRIES && Date.now() < deadline; attempt++) {
      // Re-send only the missing native receive readiness signal. This is deliberately
      // same-point and direct, so it never becomes a pointer movement or generic dragOver.
      await this.cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...point, data });
      await this.boundedValue(
        `new Promise(resolve=>{const done=()=>resolve(true);requestAnimationFrame(done);setTimeout(done,${NATIVE_DRAGOVER_FRAME_LIMIT_MS});})`,
        NATIVE_DRAGOVER_FRAME_LIMIT_MS + 100,
        'native dragover readiness frame'
      );
      events = await this.syncDragEvents();
      over = events.filter((event) => event.type === 'dragover' && near(event));
    }
    assert(over.length, `Trusted native dragover missing at ${name}: ${JSON.stringify(events)}`);
    const enter = events.filter((event) => event.type === 'dragenter' && near(event));
    // Chromium can omit dragenter when the hit target does not change; retain it when emitted.
    if (enter.length)
      assert(
        enter.some((candidate) => events.indexOf(candidate) < events.indexOf(over.at(-1)!)),
        `Native dragenter was not paired before dragover at ${name}: ${JSON.stringify(events)}`
      );
    return { over: over.at(-1)!, enter: enter.at(-1) ?? null };
  }
  async dragOver(data: Record<string, unknown>, point: Point, enter = false) {
    await this.move(point, 1);
    await this.cdp.send('Input.dispatchDragEvent', {
      type: enter ? 'dragEnter' : 'dragOver',
      ...point,
      data,
    });
    await this.syncDragEvents();
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
    await this.syncDragEvents();
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
