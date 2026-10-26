import assert from 'node:assert/strict';

export interface DesktopCdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  screenshot(file: string): Promise<void>;
  close(): Promise<void>;
  on(method: string, callback: (params: unknown) => void): void;
}

export interface UiLocator {
  selector: string;
  within?: UiLocator;
  name?: string;
  textSelector?: string;
  textIncludes?: string[];
  attributes?: Record<string, string>;
  controlledBy?: UiLocator;
  visible?: boolean;
}

export interface UiElementState {
  text: string;
  value: string | null;
  disabled: boolean;
  visible: boolean;
  expanded: string | null;
  controls: string | null;
  dateTime: string | null;
  scrollWidth: number;
  clientWidth: number;
}

type UiOperation =
  | 'ready'
  | 'alerts'
  | 'inspect'
  | 'count'
  | 'active-id'
  | 'point'
  | 'operation'
  | 'tab-inspect'
  | 'tab-panel'
  | 'settled'
  | 'scroll'
  | 'catalog'
  | 'session'
  | 'environment'
  | 'browser-access';

export type UiWait = <T>(
  observe: () => Promise<T>,
  label: string,
  timeoutMs?: number
) => Promise<NonNullable<T>>;

interface OperationState {
  id: string | null;
  status: string | null;
  dialogOpen: boolean;
}

// Checked-in code only, following the existing opencode-input-modalities CDP idiom.
// Labels, selectors and durable identities cross CallArgument.value, never source code.
const RENDERER = `async function(operation, data) {
  function locateAll(locator) {
    let root = locator.within ? locate(locator.within) : document;
    if (locator.controlledBy) {
      const id = locate(locator.controlledBy)?.getAttribute('aria-controls');
      root = id ? document.getElementById(id) : null;
      if (root?.getAttribute('role') !== 'listbox') return [];
    }
    if (!root) return [];
    return Array.from(root.querySelectorAll(locator.selector)).filter(element => {
      const text = (locator.textSelector ? element.querySelector(locator.textSelector) : element)
        ?.textContent?.trim() ?? '';
      return (locator.name === undefined || text === locator.name ||
          element.getAttribute('aria-label') === locator.name) &&
        (locator.textIncludes ?? []).every(value => text.includes(value)) &&
        (!locator.visible || visible(element)) &&
        Object.entries(locator.attributes ?? []).every(([name, value]) =>
          element.getAttribute(name) === value);
    });
  }
  function locate(locator) { return locateAll(locator)[0] ?? null; }
  const visible = element => element instanceof HTMLElement &&
    element.checkVisibility({checkOpacity: true, checkVisibilityCSS: true});
  if (operation === 'ready') return Boolean(window.electronAPI?.extensionManagement &&
    document.querySelector('button'));
  if (operation === 'alerts')
    return Array.from(document.querySelectorAll('[role=alert]')).map(element => element.textContent);
  if (operation === 'active-id') return document.activeElement?.id ?? null;
  if (operation === 'count') return locateAll(data[0]).length;
  if (operation === 'inspect') {
    const element = locate(data[0]);
    if (!element) return null;
    return {text: element.textContent?.trim() ?? '',
      value: typeof element.value === 'string' ? element.value : null,
      disabled: element.matches(':disabled, [aria-disabled="true"]'), visible: visible(element),
      expanded: element.getAttribute('aria-expanded'), controls: element.getAttribute('aria-controls'),
      dateTime: element.querySelector('time')?.dateTime ?? null,
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth};
  }
  if (operation === 'point') {
    const element = locate(data[0]);
    if (!(element instanceof HTMLElement)) return null;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.getAnimations().some(animation => {
        const endTime = animation.effect?.getComputedTiming().endTime;
        return (animation.pending || animation.playState === 'running') &&
          typeof endTime === 'number' && Number.isFinite(endTime);
      })) return null;
    }
    element.scrollIntoView({block: 'center', behavior: 'instant'});
    const previous = element.getBoundingClientRect();
    await new Promise(requestAnimationFrame);
    if (!element.isConnected || element.matches(':disabled, [aria-disabled="true"]') ||
        !visible(element)) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 ||
        ['x', 'y', 'width', 'height'].some(key => rect[key] !== previous[key])) return null;
    const point = {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
    if (!element.contains(document.elementFromPoint(point.x, point.y))) return null;
    return point;
  }
  if (operation === 'operation') {
    const operation = locate(data[0])?.querySelector('[data-testid=uap-operation]');
    return {id: operation?.querySelector('details > p:last-child')?.textContent?.trim() ?? null,
      status: operation?.firstElementChild?.firstElementChild?.textContent?.trim() ?? null,
      dialogOpen: Boolean(document.querySelector('[role=dialog]'))};
  }
  if (operation === 'tab-inspect' || operation === 'tab-panel') {
    const tab = locate(data[0]);
    const selected = tab?.getAttribute('aria-selected') === 'true';
    const id = tab?.getAttribute('aria-controls');
    const panel = id ? document.getElementById(id) : null;
    if (operation === 'tab-panel') {
      if (!selected) throw new Error('Selected tab regressed before its panel became visible');
      return panel?.getAttribute('role') === 'tabpanel' && visible(panel);
    }
    const rect = tab?.getBoundingClientRect();
    const hit = rect ? document.elementFromPoint(rect.x + rect.width / 2,
      rect.y + rect.height / 2) : null;
    const describe = element => element ? {tag: element.tagName, id: element.id,
      role: element.getAttribute('role'), text: element.textContent?.trim().slice(0, 160)} : null;
    return {requested: data[0].name, target: describe(tab), selected,
      selectedTabs: Array.from(document.querySelectorAll('[role=tab][aria-selected=true]'))
        .map(element => element.textContent?.trim()),
      rect: rect ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height} : null,
      panelId: id, panelPresent: Boolean(panel), panelVisible: visible(panel),
      hitTarget: describe(hit), targetContainsHit: Boolean(tab?.contains(hit))};
  }
  if (operation === 'settled') {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return document.getAnimations().every(animation => {
      const endTime = animation.effect?.getComputedTiming().endTime;
      return !(animation.pending || animation.playState === 'running') ||
        typeof endTime !== 'number' || !Number.isFinite(endTime);
    });
  }
  if (operation === 'scroll') {
    const element = locate(data[0]);
    if (!element) throw new Error('Missing UAP panel');
    element.scrollIntoView({block: 'start'});
    return true;
  }
  if (operation === 'browser-access') return window.electronAPI.extensionManagement.browserAccess();
  if (operation === 'catalog' || operation === 'session' || operation === 'environment') {
    const api = window.electronAPI.extensionManagement;
    const context = await api.capture({client: 'opencode', scope: 'user'});
    if (operation === 'session') return context.session;
    return operation === 'catalog' ? api.catalog({contextId: context.contextId})
      : api.environment({contextId: context.contextId});
  }
  throw new Error('Unknown UAP desktop fixture operation');
}`;

interface CdpResult<T> {
  result?: { objectId?: string; value?: T };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

export async function callUi<T>(
  cdp: DesktopCdp,
  operation: UiOperation,
  data: readonly unknown[] = []
): Promise<T> {
  const global = (await cdp.send('Runtime.evaluate', {
    expression: 'globalThis',
    returnByValue: false,
  })) as CdpResult<never>;
  const objectId = global.result?.objectId;
  assert(objectId, 'Owned renderer global object is required');
  let completed = false;
  try {
    const result = (await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: RENDERER,
      arguments: [{ value: operation }, { value: data }],
      awaitPromise: true,
      returnByValue: true,
    })) as CdpResult<T>;
    const exception = result.exceptionDetails;
    assert(
      !exception,
      exception?.exception?.description ?? exception?.text ?? 'Renderer fixture call failed'
    );
    completed = true;
    return result.result?.value as T;
  } finally {
    // A destroyed context can also lose its object handle. Preserve the original
    // observation failure so the existing bounded wait can recognize that context error.
    await cdp.send('Runtime.releaseObject', { objectId }).catch((error) => {
      if (completed) throw error;
    });
  }
}

export function inspectElement(cdp: DesktopCdp, locator: UiLocator) {
  return callUi<UiElementState | null>(cdp, 'inspect', [locator]);
}

// The existing bounded wait retries this check while a refresh disables controls.
// Hit testing also keeps pointer input out of hidden or obscured dialog controls.
export function actionablePoint(cdp: DesktopCdp, locator: UiLocator) {
  return callUi<{ x: number; y: number } | null>(cdp, 'point', [locator]);
}

export async function dispatchKey(
  cdp: DesktopCdp,
  key: string,
  code: string,
  modifiers: number
): Promise<void> {
  const virtualKeys: Record<string, number> = { KeyA: 65, Tab: 9, Escape: 27 };
  for (const type of ['rawKeyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      modifiers,
      windowsVirtualKeyCode: virtualKeys[code],
    });
  }
}

export async function applyAndWaitForOperation(
  cdp: DesktopCdp,
  wait: UiWait,
  root: UiLocator,
  apply: () => Promise<void>,
  label = 'completed operation',
  timeoutMs = 120_000
): Promise<void> {
  // The final paragraph in Details displays the actual operation ID.
  const previous = await callUi<OperationState>(cdp, 'operation', [root]);
  await apply();
  await wait(
    async () => {
      const current = await callUi<OperationState>(cdp, 'operation', [root]);
      return (
        !current.dialogOpen &&
        Boolean(current.id) &&
        current.id !== previous.id &&
        current.status === 'Completed'
      );
    },
    label,
    timeoutMs
  );
}

// Only navigation is retried. A witnessed selection is latched: a later reset fails.
export async function selectTab(cdp: DesktopCdp, wait: UiWait, label: string): Promise<void> {
  const tab: UiLocator = { selector: '[role=tab]', name: label };
  const inspect = () => callUi<{ selected: boolean }>(cdp, 'tab-inspect', [tab]);
  const selected = async () => (await inspect()).selected;
  const deadline = Date.now() + 60_000;
  const remaining = () => Math.max(0, deadline - Date.now());
  const observations: unknown[] = [];
  try {
    for (let attempt = 1; attempt <= 3 && remaining() > 0; attempt++) {
      if (!(await selected())) {
        // Dispatch the successful point observation itself, without a second readiness race.
        const point = await wait(
          () => actionablePoint(cdp, tab),
          `enabled visible ${label} tab`,
          remaining()
        );
        const observation = await inspect();
        observations.push({ attempt, ...observation });
        if (!observation.selected) {
          for (const type of ['mousePressed', 'mouseReleased'])
            await cdp.send('Input.dispatchMouseEvent', {
              type,
              ...point,
              button: 'left',
              clickCount: 1,
            });
          const selectionLabel = `${label} tab selection`;
          try {
            await wait(selected, selectionLabel, Math.min(3000, remaining()));
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.startsWith(`Timed out waiting for ${selectionLabel};`)
            )
              continue;
            throw error;
          }
        }
      }
      // Selection was observed. Do not re-click if mounting or later state now fails.
      await wait(() => callUi(cdp, 'tab-panel', [tab]), `${label} tab panel`, remaining());
      return;
    }
    throw new Error('Tab was not selected within three pointer attempts');
  } catch (error) {
    observations.push(await inspect().catch((cause) => ({ observationError: String(cause) })));
    throw new Error(`Tab navigation failed: ${label}; ${JSON.stringify(observations)}`, {
      cause: error,
    });
  }
}

export async function screenshotWhenSettled(
  cdp: DesktopCdp,
  wait: UiWait,
  file: string
): Promise<void> {
  await wait(() => callUi(cdp, 'settled'), `finite UI animations before screenshot ${file}`);
  // Infinite activity indicators remain live; no animation is disabled or advanced.
  await cdp.screenshot(file);
}
