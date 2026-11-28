import { createElement } from 'react';
import ReactMarkdown from 'react-markdown';
import { renderToStaticMarkup } from 'react-dom/server';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { revealDesktopReply } from '../../scripts/legacy-agent-host/desktop-reply-visibility.ts';

const messageId = 'TEST-host-cost-output';
const report = [
  'Codex usage reported to this Host',
  'Scope: retained activity for the captured session.',
  'Input tokens reported: 720',
  'Output tokens reported: 42',
  'Price: not reported by Codex.',
  'Elapsed since this launch: 26s',
].join('\n');
const fragments = report.split('\n').map((_, index) => new DOMRect(20, 20 + index * 20, 300, 18));
const rectList = (rects: DOMRect[]): DOMRectList =>
  Object.assign(rects, { item: (index: number) => rects[index] ?? null });
let target: HTMLElement | null;
let clipped: boolean;

function appendReport(key: string, text = report): HTMLElement {
  const row = document.createElement('div');
  row.setAttribute('data-timeline-row-key', key);
  row.innerHTML = renderToStaticMarkup(createElement(ReactMarkdown, { children: text }));
  document.body.appendChild(row);
  return row;
}

function reader(onRead?: () => void) {
  const send = vi.fn();
  const step = vi.fn();
  const assertOwnedRenderer = vi.fn();
  const evaluate = vi.fn(async (expression: string): Promise<unknown> => {
    const value: unknown = Function(`return ${expression}`)();
    onRead?.();
    return value;
  });
  return { cdp: { evaluate, send }, options: { messageId, step, assertOwnedRenderer } };
}

beforeEach(() => {
  vi.useFakeTimers();
  target = null;
  clipped = false;
  vi.stubGlobal('innerWidth', 800);
  vi.stubGlobal('innerHeight', 600);
  // happy-dom has no layout and drops the first soft newline in innerText. Model
  // Chromium's whitespace collapse from the actual Markdown text, not an expected answer.
  vi.spyOn(HTMLElement.prototype, 'innerText', 'get').mockImplementation(function (this: HTMLElement) {
    return this.textContent.replace(/\s+/g, ' ').trim();
  });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue(
    rectList([new DOMRect(0, 0, 800, 600)])
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 800, 600)
  );
  vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue(rectList(fragments));
  vi.spyOn(document, 'elementFromPoint').mockImplementation(() => target?.querySelector('p') ?? null);
  vi.stubGlobal('getComputedStyle', (element: HTMLElement) => ({
    visibility: 'visible',
    opacity: '1',
    overflowY: clipped && element === target ? 'hidden' : 'visible',
    overflowX: 'visible',
  }));
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('waits for the exact report row after the receipt, then proves every visible text fragment', async () => {
  appendReport('TEST-older-report');
  const { cdp, options } = reader(() => {
    target ??= appendReport(messageId);
  });
  const assertion = expect(revealDesktopReply(cdp, report, options)).resolves.toMatchObject({
    visible: true,
    messageId,
    fragments: fragments.map(() => ({ visible: true })),
  });
  await Promise.all([assertion, vi.runAllTimersAsync()]);
  expect(cdp.evaluate).toHaveBeenCalledTimes(2);
  expect(options.assertOwnedRenderer).toHaveBeenCalledTimes(2);
  expect(options.step).toHaveBeenCalledTimes(1);
  expect(cdp.send).not.toHaveBeenCalled();
});

it.each(['wrong identity', 'missing final line', 'clipped final line'] as const)(
  'refuses an incomplete report proof: %s',
  async (failure) => {
    appendReport('TEST-older-report');
    if (failure !== 'wrong identity') {
      target = appendReport(
        messageId,
        failure === 'missing final line' ? report.split('\n').slice(0, -1).join('\n') : report
      );
    }
    if (failure === 'clipped final line') {
      clipped = true;
      Object.defineProperty(target, 'clientHeight', { configurable: true, value: 120 });
    }
    const { cdp, options } = reader();
    const assertion = expect(revealDesktopReply(cdp, report, options)).rejects.toThrow(
      'Reply viewport visibility unconfirmed; no business mutation replay'
    );
    await Promise.all([assertion, vi.runAllTimersAsync()]);
    expect(cdp.evaluate).toHaveBeenCalledTimes(12);
    expect(options.step).not.toHaveBeenCalled();
    expect(cdp.send).not.toHaveBeenCalled();
  }
);
