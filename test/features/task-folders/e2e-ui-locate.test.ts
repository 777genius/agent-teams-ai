import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  folderRow,
  selectors,
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
});
