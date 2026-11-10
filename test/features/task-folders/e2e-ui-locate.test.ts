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

function appendVirtualRow(tree: HTMLElement, row: HTMLElement, start: number, height = 100) {
  const wrapper = document.createElement('div');
  wrapper.dataset.index = String(start);
  wrapper.style.transform = `translateY(${start}px)`;
  wrapper.getBoundingClientRect = () => ({
    top: start - tree.scrollTop,
    bottom: start + height - tree.scrollTop,
    height,
  }) as DOMRect;
  wrapper.append(row);
  tree.append(wrapper);
}

function renderVirtualTree(tree: HTMLElement, scrollTop: number) {
  tree.replaceChildren();
  if (scrollTop < 200) {
    const row = document.createElement('div');
    row.setAttribute('data-folder-id', 'visible-before-scroll');
    row.setAttribute('data-task-key', JSON.stringify(['virtual-team', 'visible-before-scroll']));
    appendVirtualRow(tree, row, scrollTop);
    return;
  }
  const folderRowElement = document.createElement('div');
  folderRowElement.setAttribute('data-folder-id', folderId);
  appendVirtualRow(tree, folderRowElement, scrollTop);
  if (scrollTop >= 300) {
    const row = document.createElement('div');
    row.setAttribute('data-task-key', JSON.stringify(taskIdentity));
    appendVirtualRow(tree, row, scrollTop + 100);
  }
}

function createUi(
  onFrame?: () => void,
  renderTree = renderVirtualTree,
  initialScrollTop = 0
) {
  document.body.innerHTML = `<div data-testid="task-folders-tree"></div><div id="sidebar-tasks-panel"></div>`;
  const tree = document.querySelector<HTMLElement>(selectors.tree)!;
  const scrollTops: number[] = [];
  let scrollTop = initialScrollTop;
  tree.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100 }) as DOMRect;
  Object.defineProperty(tree, 'clientHeight', { configurable: true, value: 100 });
  Object.defineProperty(tree, 'scrollHeight', { configurable: true, value: 500 });
  Object.defineProperty(tree, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      if (scrollTop === value) return;
      scrollTop = value;
      scrollTops.push(value);
      renderTree(tree, value);
    },
  });
  renderTree(tree, scrollTop);
  const evaluate = (expression: string) => {
    const run = new Function(
      'document',
      'requestAnimationFrame',
      `return (${expression});`
    ) as (doc: Document, raf: (callback: () => void) => number) => unknown;
    return run(document, (callback) => {
      queueMicrotask(() => {
        onFrame?.();
        callback();
      });
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
    vi.restoreAllMocks();
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

  it('holds a scroll waypoint until its real virtual range commits despite a pinned source', async () => {
    let pending: number | undefined;
    let frames = 0;
    const renderRange = (target: HTMLElement, top: number) => {
      target.replaceChildren();
      const row = document.createElement('div');
      row.setAttribute('data-folder-id', top === 0 ? folderId : 'old-range');
      appendVirtualRow(target, row, top);
      if (top !== 0) {
        const pinned = document.createElement('div');
        pinned.setAttribute('data-folder-id', 'pinned-source');
        appendVirtualRow(target, pinned, 0, 20);
      }
    };
    const fixture = createUi(
      () => {
        if (pending !== undefined && ++frames === 3) renderRange(fixture.tree, pending);
      },
      (target, top) => {
        if (!target.firstElementChild) renderRange(target, top);
        else {
          pending = top;
          frames = 0;
        }
      },
      400
    );
    const { tree } = fixture;

    await fixture.ui.locate(folderRow(folderId));

    expect(fixture.scrollTops).toEqual([0]);
    expect(frames).toBe(3);
    expect(tree.querySelector(`[data-folder-id="${folderId}"]`)).not.toBeNull();
  });

  it('accepts a committed range shorter than the viewport without waiting for blank space', async () => {
    vi.useFakeTimers();
    let frames = 0;
    const fixture = createUi(
      () => {
        vi.setSystemTime(Date.now() + 1000);
        if (++frames === 2) {
          fixture.tree.querySelector('[data-folder-id]')!.setAttribute('data-folder-id', folderId);
        }
      },
      (tree) => {
        if (tree.firstElementChild) return;
        const row = document.createElement('div');
        row.setAttribute('data-folder-id', 'before-commit');
        appendVirtualRow(tree, row, 0, 20);
      }
    );
    Object.defineProperty(fixture.tree, 'scrollHeight', { configurable: true, value: 100 });

    await fixture.ui.locate(folderRow(folderId), Date.now() + 5000);

    expect(frames).toBe(2);
    expect(fixture.scrollTops).toEqual([]);
  });

  it('bounds an uncommitted viewport by the supplied readiness deadline', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const { ui, tree, scrollTops } = createUi(
      () => {
        vi.setSystemTime(Date.now() + 1000);
      },
      (target) => {
        if (target.firstElementChild) return;
        appendVirtualRow(target, document.createElement('div'), 400);
        appendVirtualRow(target, document.createElement('div'), 0, 20);
      },
      400
    );

    await expect(ui.locate(folderRow(folderId), started + 5000)).rejects.toThrow(
      'viewport commit deadline'
    );

    expect(Date.now() - started).toBe(5000);
    expect(scrollTops).toEqual([0]);
    expect(tree.querySelector(`[data-folder-id="${folderId}"]`)).toBeNull();
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

  function mockFolderGeometry(tree: HTMLElement, onScroll: (row: HTMLElement) => void) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 20,
      width: 100,
      height: 20,
    } as DOMRect);
    Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
      configurable: true,
      value(this: HTMLElement) {
        return this.isConnected;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: HTMLElement) {
        onScroll(this);
      },
    });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => tree.querySelector(`[data-folder-id="${folderId}"]`),
    });
  }

  it('requalifies the same folder when its highlight is lost after the initial wait', async () => {
    const { ui, tree } = createUi();
    tree.scrollTop = 200;
    tree.querySelector(`[data-folder-id="${folderId}"]`)!.classList.add('bg-blue-500/20');
    let samples = 0;
    mockFolderGeometry(tree, (row) => {
      samples++;
      row.classList.toggle('bg-blue-500/20', samples > 1);
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      x: 10, y: samples * 20, width: 100, height: 20,
    } as DOMRect));

    await expect(ui.folderPoint(folderId, true)).resolves.toEqual({
      x: 60,
      y: 50,
      folderId,
      hitFolderId: folderId,
      dragTargetHighlighted: true,
    });
    expect(samples).toBe(2);
  });

  it('rejects a permanently lost highlight within the fixed geometry deadline', async () => {
    vi.useFakeTimers();
    const { ui, tree } = createUi();
    tree.scrollTop = 200;
    tree.querySelector(`[data-folder-id="${folderId}"]`)!.classList.add('bg-blue-500/20');
    let samples = 0;
    mockFolderGeometry(tree, (row) => {
      samples++;
      row.classList.remove('bg-blue-500/20');
    });
    const started = Date.now();
    let settled = false;
    const result = ui.folderPoint(folderId, true).finally(() => {
      settled = true;
    });
    const failure = expect(result).rejects.toThrow('Vendor drag-target highlight missing');

    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(Date.now() - started).toBe(5000);
    expect(samples).toBeGreaterThan(1);
  });

  it('allows initial tree discovery beyond 5s before starting geometry readiness', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const { ui, tree } = createUi(() => {
      vi.setSystemTime(Date.now() + 2000);
    });
    mockFolderGeometry(tree, () => undefined);

    await expect(ui.point(folderRow(folderId))).resolves.toEqual({ x: 60, y: 30 });
    expect(Date.now() - started).toBe(6000);
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
