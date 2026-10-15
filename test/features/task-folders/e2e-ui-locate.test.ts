import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  folderRow,
  selectors,
  taskKeyData,
  taskRow,
  UI,
} from '../../../scripts/e2e/task-folders/ui.ts';

type UIConstructor = ConstructorParameters<typeof UI>[0];
const folderId = 'virtual-folder';
const taskIdentity = ['virtual-team', 'virtual-task'] as const;

function renderVirtualTree(tree: HTMLElement, scrollTop: number) {
  tree.replaceChildren();
  if (scrollTop < 200) {
    const row = document.createElement('div');
    row.setAttribute('data-folder-id', 'visible-before-scroll');
    row.setAttribute('data-task-key', JSON.stringify(['virtual-team', 'visible-before-scroll']));
    tree.append(row);
    return;
  }
  const folderRowElement = document.createElement('div');
  folderRowElement.setAttribute('data-folder-id', folderId);
  tree.append(folderRowElement);
  if (scrollTop >= 300) {
    const row = document.createElement('div');
    row.setAttribute('data-task-key', JSON.stringify(taskIdentity));
    tree.append(row);
  }
}

function createUi() {
  document.body.innerHTML = `<div data-testid="task-folders-tree"></div><div id="sidebar-tasks-panel"></div>`;
  const tree = document.querySelector<HTMLElement>(selectors.tree)!;
  const scrollTops: number[] = [];
  let scrollTop = 0;
  Object.defineProperty(tree, 'clientHeight', { configurable: true, value: 100 });
  Object.defineProperty(tree, 'scrollHeight', { configurable: true, value: 500 });
  Object.defineProperty(tree, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
      scrollTops.push(value);
      renderVirtualTree(tree, value);
    },
  });
  renderVirtualTree(tree, scrollTop);
  const evaluate = (expression: string) => {
    const run = new Function(
      'document',
      'requestAnimationFrame',
      `return (${expression});`
    ) as (doc: Document, raf: (callback: () => void) => number) => unknown;
    return run(document, (callback) => {
      queueMicrotask(callback);
      return 0;
    });
  };
  const desktop = {
    cdp: {
      evaluate: async (expression: string) => evaluate(expression),
      send: async () => undefined,
      on: () => undefined,
      screenshot: async () => undefined,
      close: async () => undefined,
    },
  } as unknown as UIConstructor;
  return { ui: new UI(desktop), scrollTops, tree };
}

describe('task-folders desktop UI target location', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('navigates helper-generated folder and task expressions through virtual scrolling', async () => {
    const { ui, scrollTops, tree } = createUi();

    await ui.locate(folderRow(folderId));
    expect(scrollTops).toContain(200);
    expect(tree.querySelector(`[data-folder-id="${folderId}"]`)).not.toBeNull();

    await ui.locate(taskRow(taskIdentity[0], taskIdentity[1]));
    expect(scrollTops.filter((top) => top === 200)).toHaveLength(2);
    expect(
      tree.querySelector(`[data-task-key='${JSON.stringify(taskIdentity)}']`)
    ).not.toBeNull();
  });

  it('keeps non-tree helper targets on the bounded presence path', async () => {
    vi.useFakeTimers();
    const { ui } = createUi();
    const missing = ui.locate(taskRow('virtual-team', 'missing', selectors.sidebar));
    const failure = expect(missing).rejects.toThrow(
      'Missing selector after 5000ms target presence wait'
    );
    await vi.runAllTimersAsync();
    await failure;
  });

  it('passes one encoded task key as structured CDP data at the DOM boundary', async () => {
    const taskKey = taskKeyData(taskIdentity[0], taskIdentity[1]);
    const card = document.createElement('div');
    card.setAttribute('data-task-key', taskKey);
    document.body.append(card);

    expect(card.getAttribute('data-task-key')).toBe(taskKey);
    expect(JSON.parse(card.getAttribute('data-task-key')!)).toEqual(taskIdentity);

    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const desktop = {
      cdp: {
        evaluate: async () => undefined,
        send: async (method: string, payload: Record<string, unknown>) => {
          calls.push({ method, payload });
          if (method === 'Runtime.evaluate') return { result: { objectId: 'global-this' } };
          if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
          return {};
        },
        on: () => undefined,
        screenshot: async () => undefined,
        close: async () => undefined,
      },
    } as unknown as UIConstructor;
    const ui = new UI(desktop);

    await expect(
      ui.callFunction<boolean>('function(taskKey){return true;}', [taskKey])
    ).resolves.toBe(true);
    expect(calls.map(({ method }) => method)).toEqual([
      'Runtime.evaluate',
      'Runtime.callFunctionOn',
      'Runtime.releaseObject',
    ]);
    expect(calls[1].payload.arguments).toEqual([{ value: taskKey }]);
  });

  it('reacquires the same virtual target when point geometry unmounts it', async () => {
    const { ui, tree } = createUi();
    tree.scrollTop = 200;
    let scrollIntoViewCalls = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return { x: 10, y: 20, width: 100, height: 20 } as DOMRect;
    });
    Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
      configurable: true,
      value(this: HTMLElement) {
        return this.isConnected;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value() {
        scrollIntoViewCalls++;
        if (scrollIntoViewCalls === 1) tree.scrollTop = 0;
      },
    });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => tree.querySelector(`[data-folder-id="${folderId}"]`),
    });

    const point = await ui.point(folderRow(folderId));

    expect(point).toEqual({ x: 60, y: 30 });
    expect(scrollIntoViewCalls).toBe(2);
    expect(tree.querySelector(`[data-folder-id="${folderId}"]`)).not.toBeNull();
  });
});
