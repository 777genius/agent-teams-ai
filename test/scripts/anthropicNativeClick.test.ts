import { runInNewContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clickNativeControl,
  nativeClickPointExpression,
} from '../../scripts/e2e/anthropic-compatible-status/native-click';

import type { NativeClickPoint } from '../../scripts/e2e/anthropic-compatible-status/native-click';

const targetExpression = 'document.querySelector("#target")';

function fixture() {
  const target = document.createElement('button');
  target.id = 'target';
  const child = document.createElement('span');
  target.append(child);
  document.body.append(target);
  const scroll = vi.spyOn(target, 'scrollIntoView').mockImplementation(() => undefined);
  const rect = vi
    .spyOn(target, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(100, 200, 80, 30));
  const hit = vi.spyOn(document, 'elementFromPoint').mockReturnValue(child);
  const frames: FrameRequestCallback[] = [];
  const evaluate = (expression: string): Promise<NativeClickPoint | null> =>
    runInNewContext(expression, {
      document,
      window: { innerWidth: 800, innerHeight: 600 },
      requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
    });
  const frame = async () => {
    expect(frames.length).toBe(1);
    frames.shift()!(0);
    await Promise.resolve();
    await Promise.resolve();
  };
  const prepare = () => evaluate(nativeClickPointExpression(targetExpression));
  return { target, child, scroll, rect, hit, frames, evaluate, frame, prepare };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('Anthropic packaged native click preparation', () => {
  it('accepts a stable descendant hit only after both layout frames', async () => {
    const f = fixture();
    const point = f.prepare();
    expect(f.scroll).toHaveBeenCalledWith({
      behavior: 'instant',
      block: 'center',
      inline: 'nearest',
    });
    expect(f.hit).not.toHaveBeenCalled();
    await f.frame();
    expect(f.hit).not.toHaveBeenCalled();
    await f.frame();
    await expect(point).resolves.toEqual({ x: 140, y: 215 });
    expect(f.hit).toHaveBeenCalledWith(140, 215);
  });

  it.each([
    [-100, 200, 80, 30],
    [100, -40, 80, 30],
    [780, 200, 80, 30],
    [100, 590, 80, 30],
    [100, 200, 0, 30],
  ])('rejects an off-screen or empty center (%s, %s, %s, %s)', async (x, y, width, height) => {
    const f = fixture();
    f.rect.mockReturnValue(new DOMRect(x, y, width, height));
    const point = f.prepare();
    await f.frame();
    await f.frame();
    await expect(point).resolves.toBeNull();
    expect(f.hit).not.toHaveBeenCalled();
  });

  it.each(['covered', 'clipped'])(
    'rejects a nonzero rect whose center is %s by another element',
    async (state) => {
      const f = fixture();
      const blocker = document.createElement('div');
      if (state === 'clipped') blocker.append(f.target);
      document.body.append(blocker);
      f.hit.mockReturnValue(blocker);
      const point = f.prepare();
      await f.frame();
      await f.frame();
      await expect(point).resolves.toBeNull();
    }
  );

  it('rejects coordinates that drift between rendered frames', async () => {
    const f = fixture();
    const point = f.prepare();
    await f.frame();
    f.rect.mockReturnValue(new DOMRect(100, 240, 80, 30));
    await f.frame();
    await expect(point).resolves.toBeNull();
    expect(f.hit).not.toHaveBeenCalled();
  });

  it.each(['detached', 'remounted', 'disabled'])(
    'rejects a control that becomes %s while layout settles',
    async (change) => {
      const f = fixture();
      const point = f.prepare();
      await f.frame();
      if (change === 'detached') f.target.remove();
      if (change === 'remounted') {
        f.target.id = 'old-target';
        const replacement = document.createElement('button');
        replacement.id = 'target';
        document.body.append(replacement);
      }
      if (change === 'disabled') f.target.disabled = true;
      await f.frame();
      await expect(point).resolves.toBeNull();
      expect(f.hit).not.toHaveBeenCalled();
    }
  );

  it('rejects an initially disabled control without scrolling or scheduling frames', async () => {
    const f = fixture();
    f.target.disabled = true;
    await expect(f.prepare()).resolves.toBeNull();
    expect(f.scroll).not.toHaveBeenCalled();
    expect(f.frames).toHaveLength(0);
  });

  it('sends no input until a covered control becomes ready, then clicks exactly once', async () => {
    const f = fixture();
    f.hit.mockReturnValue(document.body);
    const send = vi.fn(async () => undefined);
    const driver = {
      async wait<T>(expression: string, label: string): Promise<T> {
        expect(label).toBe('Custom path');
        expect(await f.evaluate(expression)).toBeNull();
        expect(send).not.toHaveBeenCalled();
        f.hit.mockReturnValue(f.child);
        return (await f.evaluate(expression)) as T;
      },
      send,
    };
    const click = clickNativeControl(driver, targetExpression, 'Custom path');
    await f.frame();
    await f.frame();
    expect(send).not.toHaveBeenCalled();
    await f.frame();
    expect(send).not.toHaveBeenCalled();
    await f.frame();
    await click;
    expect(send.mock.calls).toEqual(
      ['mousePressed', 'mouseReleased'].map((type) => [
        'Input.dispatchMouseEvent',
        { type, button: 'left', clickCount: 1, x: 140, y: 215 },
      ])
    );
  });

  it('does not dispatch input when readiness times out', async () => {
    const send = vi.fn(async () => undefined);
    const driver = {
      async wait<T>(): Promise<T> {
        throw new Error('Timed out: Custom path');
      },
      send,
    };
    await expect(clickNativeControl(driver, targetExpression, 'Custom path')).rejects.toThrow(
      'Timed out: Custom path'
    );
    expect(send).not.toHaveBeenCalled();
  });
});
