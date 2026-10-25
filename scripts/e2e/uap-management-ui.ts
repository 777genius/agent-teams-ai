export interface DesktopCdp {
  evaluate(expression: string): Promise<unknown>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  screenshot(file: string): Promise<void>;
  close(): Promise<void>;
  on(method: string, callback: (params: unknown) => void): void;
}

type UiWait = (expression: string, label: string, timeoutMs?: number) => Promise<void>;

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
  root: string,
  apply: () => Promise<void>,
  label = 'completed operation',
  timeoutMs = 120_000
): Promise<void> {
  const operation = `(${root})?.querySelector('[data-testid=uap-operation]')`;
  // The final paragraph in the existing Details section displays the actual operation ID.
  const identity = `${operation}?.querySelector('details > p:last-child')?.textContent?.trim()`;
  const previousId = await cdp.evaluate(identity);
  await apply();
  await wait(
    `(() => {
      const operation = ${operation};
      const id = ${identity};
      const status = operation?.firstElementChild?.firstElementChild?.textContent?.trim();
      return !document.querySelector('[role=dialog]') && id &&
        id !== ${JSON.stringify(previousId)} && status === 'Completed';
    })()`,
    label,
    timeoutMs
  );
}

// The existing bounded wait retries this same check while a refresh disables controls.
// Hit testing also keeps pointer input out of hidden or obscured dialog controls.
export function actionablePoint(expression: string): string {
  return `(async () => {
    const element = (${expression});
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
        !element.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 ||
        ['x', 'y', 'width', 'height'].some(key => rect[key] !== previous[key])) return null;
    const point = {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
    if (!element.contains(document.elementFromPoint(point.x, point.y))) return null;
    return point;
  })()`;
}

// Only navigation is retried. A witnessed selection is latched: a later reset fails.
export async function selectTab(cdp: DesktopCdp, wait: UiWait, label: string): Promise<void> {
  const tab = `Array.from(document.querySelectorAll('[role=tab]')).find(element =>
    element.textContent?.trim() === ${JSON.stringify(label)})`;
  const selected = `(${tab})?.getAttribute('aria-selected') === 'true'`;
  const panelReady = `(() => {
    const tab = ${tab};
    if (tab?.getAttribute('aria-selected') !== 'true')
      throw new Error('Selected tab regressed before its panel became visible');
    const id = tab.getAttribute('aria-controls');
    const panel = id ? document.getElementById(id) : null;
    return panel instanceof HTMLElement && panel.getAttribute('role') === 'tabpanel' &&
      panel.checkVisibility({checkOpacity: true, checkVisibilityCSS: true});
  })()`;
  const inspect = () =>
    cdp.evaluate(`(() => {
    const tab = ${tab};
    const rect = tab?.getBoundingClientRect();
    const id = tab?.getAttribute('aria-controls');
    const panel = id ? document.getElementById(id) : null;
    const hit = rect ? document.elementFromPoint(rect.x + rect.width / 2,
      rect.y + rect.height / 2) : null;
    const describe = element => element ? {tag: element.tagName, id: element.id,
      role: element.getAttribute('role'), text: element.textContent?.trim().slice(0, 160)} : null;
    return {requested: ${JSON.stringify(label)}, target: describe(tab),
      selected: tab?.getAttribute('aria-selected') === 'true',
      selectedTabs: Array.from(document.querySelectorAll('[role=tab][aria-selected=true]'))
        .map(element => element.textContent?.trim()),
      rect: rect ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height} : null,
      panelId: id, panelPresent: Boolean(panel),
      panelVisible: panel instanceof HTMLElement && panel.checkVisibility(),
      hitTarget: describe(hit), targetContainsHit: Boolean(tab?.contains(hit))};
  })()`);
  const deadline = Date.now() + 60_000;
  const remaining = () => Math.max(0, deadline - Date.now());
  const observations: unknown[] = [];
  try {
    for (let attempt = 1; attempt <= 3 && remaining() > 0; attempt++) {
      if (!(await cdp.evaluate(selected))) {
        const pointExpression = actionablePoint(tab);
        await wait(pointExpression, `enabled visible ${label} tab`, remaining());
        const point = await cdp.evaluate(pointExpression);
        const observation = (await inspect()) as { selected: boolean };
        observations.push({ attempt, ...observation });
        if (!observation.selected) {
          if (!point || typeof point !== 'object') continue;
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
      await wait(panelReady, `${label} tab panel`, remaining());
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
  await wait(
    `(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return document.getAnimations().every(animation => {
        const endTime = animation.effect?.getComputedTiming().endTime;
        return !(animation.pending || animation.playState === 'running') ||
          typeof endTime !== 'number' || !Number.isFinite(endTime);
      });
    })()`,
    `finite UI animations before screenshot ${file}`
  );
  // Infinite activity indicators remain live; no animation is disabled or advanced.
  await cdp.screenshot(file);
}
