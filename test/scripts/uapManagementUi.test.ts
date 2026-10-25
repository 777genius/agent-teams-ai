import { createContext, Script } from 'node:vm';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyAndWaitForOperation,
  type DesktopCdp,
  inspectElement,
  selectTab,
  type UiWait,
} from '../../scripts/e2e/uap-management-ui';

// Execute the actual checked-in dispatcher against DOM nodes in a separate realm.
// CDP arguments are cloned as JSON values, separately from its fixed declaration.
function rendererCdp(onInput?: (params: Record<string, unknown>) => void) {
  const realm = createContext({
    document,
    HTMLElement,
    window: {},
    injected: false,
    requestAnimationFrame: (callback: (time: number) => void) => callback(0),
  });
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const cdp: DesktopCdp = {
    send: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        expect(params).toEqual({ expression: 'globalThis', returnByValue: false });
        return { result: { objectId: 'owned-renderer' } };
      }
      if (method === 'Runtime.releaseObject') return {};
      if (method === 'Input.dispatchMouseEvent') {
        onInput?.(params);
        return {};
      }
      expect(method).toBe('Runtime.callFunctionOn');
      expect(params.objectId).toBe('owned-renderer');
      expect(params.awaitPromise).toBe(true);
      expect(params.returnByValue).toBe(true);
      const args = JSON.parse(JSON.stringify(params.arguments)) as { value: unknown }[];
      // Only the production helper's fixed declaration is compiled; input stays in args.
      // eslint-disable-next-line sonarjs/code-eval
      const dispatcher = new Script(`(${String(params.functionDeclaration)})`).runInContext(realm, {
        timeout: 1000,
      }) as (...values: unknown[]) => Promise<unknown>;
      try {
        return { result: { value: await dispatcher(...args.map((argument) => argument.value)) } };
      } catch (error) {
        return { exceptionDetails: { exception: { description: String(error) } } };
      }
    },
    screenshot: () => Promise.resolve(),
    close: () => Promise.resolve(),
    on: () => {},
  };
  return { cdp, calls, realm };
}

const waitOnce: UiWait = async (observe) => {
  const value = await observe();
  if (!value) throw new Error('Expected the fixture observation to be ready');
  return value;
};

beforeEach(() => {
  document.body.replaceChildren();
  vi.spyOn(HTMLElement.prototype, 'checkVisibility').mockReturnValue(true);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('UAP desktop CDP value boundary', () => {
  it.each([
    'single\' and double" quotes; globalThis.injected = true; //',
    'line one\nline two` ${globalThis.injected = true}',
    'separators\u2028and\u2029stay data',
    '</script><script>globalThis.injected = true</script>',
  ])('matches hostile labels and durable identities as literal data: %s', async (value) => {
    const root = document.createElement('section');
    root.id = value;
    const target = document.createElement('button');
    target.textContent = value;
    root.append(target);
    const row = document.createElement('div');
    row.setAttribute('data-restore-operation-id', value);
    const time = document.createElement('time');
    time.dateTime = value;
    row.append(time);
    root.append(row);
    document.body.append(root);
    const { cdp, calls, realm } = rendererCdp();
    const within = { selector: 'section', attributes: { id: value } };

    expect(await inspectElement(cdp, { selector: 'button', within, name: value })).toMatchObject({
      text: value,
    });
    expect(
      await inspectElement(cdp, {
        selector: 'div',
        within,
        attributes: { 'data-restore-operation-id': value },
      })
    ).toMatchObject({ dateTime: value });
    expect(realm.injected).toBe(false);
    const callsIntoRenderer = calls.filter((call) => call.method === 'Runtime.callFunctionOn');
    expect(new Set(callsIntoRenderer.map((call) => call.params.functionDeclaration)).size).toBe(1);
    for (const call of callsIntoRenderer) {
      expect(call.params.functionDeclaration).not.toContain(value);
      expect(JSON.stringify(call.params.arguments)).toContain(JSON.stringify(value).slice(1, -1));
    }
    expect(calls.filter((call) => call.method === 'Runtime.releaseObject')).toHaveLength(2);
  });

  it('does not fall back to the document or another popup when the owned scope is absent', async () => {
    document.body.innerHTML =
      '<button aria-label="Remove">Remove</button>' +
      '<button id="trigger" aria-controls="owned">Agent runtime</button>' +
      '<div id="owned" role="dialog"><span role="option">OpenCode</span></div>' +
      '<div role="listbox"><span role="option">OpenCode</span></div>';
    const { cdp } = rendererCdp();
    expect(
      await inspectElement(cdp, {
        selector: 'button',
        name: 'Remove',
        within: { selector: '#missing-panel' },
      })
    ).toBeNull();
    const option = {
      selector: '[role=option]',
      name: 'OpenCode',
      controlledBy: { selector: '#trigger' },
    };
    expect(await inspectElement(cdp, option)).toBeNull();
    document.getElementById('owned')!.setAttribute('role', 'listbox');
    expect(await inspectElement(cdp, option)).toMatchObject({ text: 'OpenCode' });
  });

  it('finds a visible warning even when a matching hidden paragraph precedes it', async () => {
    document.body.innerHTML = '<div role="dialog"><p id="hidden"></p><p id="visible"></p></div>';
    const reason = 'SEC302: configuration contains an insecure http:// endpoint';
    for (const paragraph of document.querySelectorAll('p')) paragraph.textContent = reason;
    vi.spyOn(document.getElementById('hidden')!, 'checkVisibility').mockReturnValue(false);
    const { cdp } = rendererCdp();
    expect(
      await inspectElement(cdp, {
        selector: 'p',
        within: { selector: '[role=dialog]' },
        textIncludes: ['SEC302', reason],
        visible: true,
      })
    ).toMatchObject({ visible: true, text: reason });
  });

  it('rejects an invalid selector without executing it and releases the renderer handle', async () => {
    const { cdp, calls, realm } = rendererCdp();
    await expect(
      inspectElement(cdp, {
        selector: 'button); globalThis.injected = true; //',
      })
    ).rejects.toThrow();
    expect(realm.injected).toBe(false);
    expect(calls.at(-1)).toEqual({
      method: 'Runtime.releaseObject',
      params: { objectId: 'owned-renderer' },
    });
  });

  it('preserves a destroyed-context failure when releasing the lost object also fails', async () => {
    const { cdp } = rendererCdp();
    const send = cdp.send.bind(cdp);
    const contextFailure = new Error('Execution context was destroyed');
    const releaseFailure = new Error('Could not find object with given id');
    const calls = vi.spyOn(cdp, 'send').mockImplementation((method, params) => {
      if (method === 'Runtime.callFunctionOn') return Promise.reject(contextFailure);
      if (method === 'Runtime.releaseObject') return Promise.reject(releaseFailure);
      return send(method, params);
    });
    await expect(inspectElement(cdp, { selector: 'button' })).rejects.toBe(contextFailure);
    expect(calls.mock.calls.filter(([method]) => method === 'Runtime.releaseObject')).toHaveLength(
      1
    );
  });

  it('does not suppress cleanup errors after a successful observation', async () => {
    const { cdp } = rendererCdp();
    const send = cdp.send.bind(cdp);
    const releaseFailure = new Error('Unexpected CDP transport failure');
    vi.spyOn(cdp, 'send').mockImplementation((method, params) =>
      method === 'Runtime.releaseObject' ? Promise.reject(releaseFailure) : send(method, params)
    );
    await expect(inspectElement(cdp, { selector: 'button' })).rejects.toBe(releaseFailure);
  });

  it('does not accept a stale completion or an open review and applies exactly once', async () => {
    document.body.innerHTML =
      '<section id="panel"><div data-testid="uap-operation">' +
      '<div><span>Completed</span></div><details><p>old</p></details></div></section>';
    const identity = document.querySelector('details p')!;
    identity.textContent = 'old"; globalThis.injected = true; //';
    const status = document.querySelector('span')!;
    const { cdp, realm } = rendererCdp();
    const apply = vi.fn(() => Promise.resolve());
    const wait: UiWait = async (observe) => {
      expect(await observe()).toBe(false);
      identity.textContent = 'new` ${globalThis.injected = true}';
      status.textContent = 'Running';
      expect(await observe()).toBe(false);
      status.textContent = 'Completed';
      const review = document.createElement('div');
      review.setAttribute('role', 'dialog');
      document.body.append(review);
      expect(await observe()).toBe(false);
      review.remove();
      const value = await observe();
      expect(value).toBe(true);
      if (!value) throw new Error('The new completed operation must be observed');
      return value;
    };
    await applyAndWaitForOperation(cdp, wait, { selector: '#panel' }, apply);
    expect(apply).toHaveBeenCalledOnce();
    expect(realm.injected).toBe(false);
  });

  it('uses one successful pointer observation and latches the selected tab', async () => {
    document.body.innerHTML =
      '<button role="tab" aria-controls="owned" aria-selected="false">Skills</button>' +
      '<div id="owned" role="tabpanel"></div>';
    const tab = document.querySelector('button')!;
    vi.spyOn(tab, 'getBoundingClientRect').mockReturnValue(new DOMRect(4, 6, 40, 20));
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(tab);
    const { cdp, calls } = rendererCdp((params) => {
      if (params.type === 'mouseReleased') tab.setAttribute('aria-selected', 'true');
    });
    await selectTab(cdp, waitOnce, 'Skills');
    expect(
      calls.filter((call) => call.method === 'Input.dispatchMouseEvent').map((call) => call.params)
    ).toEqual([
      { type: 'mousePressed', x: 24, y: 16, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 24, y: 16, button: 'left', clickCount: 1 },
    ]);
    expect(
      calls.filter(
        (call) =>
          call.method === 'Runtime.callFunctionOn' &&
          (call.params.arguments as { value: unknown }[])[0].value === 'point'
      )
    ).toHaveLength(1);
  });

  it('fails after a witnessed tab selection regresses, without replaying pointer input', async () => {
    document.body.innerHTML =
      '<button role="tab" aria-controls="owned" aria-selected="true">Skills</button>' +
      '<div id="owned" role="tabpanel"></div>';
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(null);
    const { cdp, calls } = rendererCdp();
    const wait: UiWait = (observe, label, timeout) => {
      document.querySelector('button')!.setAttribute('aria-selected', 'false');
      return waitOnce(observe, label, timeout);
    };
    await expect(selectTab(cdp, wait, 'Skills')).rejects.toMatchObject({
      cause: { message: expect.stringContaining('Selected tab regressed') },
    });
    expect(calls.filter((call) => call.method === 'Input.dispatchMouseEvent')).toEqual([]);
  });
});
