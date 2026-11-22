export type NativeClickPoint = { x: number; y: number };

interface NativeClickDriver {
  wait<T>(expression: string, label: string): Promise<T>;
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** Inspect the native mouse target after scrolling and two rendered layout samples. */
export function nativeClickPointExpression(expression: string): string {
  return `(async () => {
    const resolve = () => (${expression});
    const e = resolve();
    const available = () => e && e.isConnected && !e.disabled && resolve() === e;
    if (!available()) return null;
    e.scrollIntoView({behavior:'instant', block:'center', inline:'nearest'});
    await new Promise(requestAnimationFrame);
    if (!available()) return null;
    const before = e.getBoundingClientRect();
    await new Promise(requestAnimationFrame);
    if (!available()) return null;
    const after = e.getBoundingClientRect();
    if (!(after.width > 0 && after.height > 0) ||
        ['left', 'top', 'width', 'height'].some(key => before[key] !== after[key])) return null;
    const x = after.left + after.width / 2;
    const y = after.top + after.height / 2;
    if (!(x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight)) return null;
    const hit = document.elementFromPoint(x, y);
    return hit === e || e.contains(hit) ? {x, y} : null;
  })()`;
}

/** Retry only point preparation; dispatch exactly one native mouse sequence. */
export async function clickNativeControl(
  driver: NativeClickDriver,
  expression: string,
  label: string
): Promise<void> {
  const point = await driver.wait<NativeClickPoint>(nativeClickPointExpression(expression), label);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await driver.send('Input.dispatchMouseEvent', {
      type,
      button: 'left',
      clickCount: 1,
      ...point,
    });
  }
}
