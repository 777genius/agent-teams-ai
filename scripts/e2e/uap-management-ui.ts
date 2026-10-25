export interface DesktopCdp {
  evaluate(expression: string): Promise<unknown>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  screenshot(file: string): Promise<void>;
  close(): Promise<void>;
  on(method: string, callback: (params: unknown) => void): void;
}

type UiWait = (expression: string, label: string, timeoutMs?: number) => Promise<void>;

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
