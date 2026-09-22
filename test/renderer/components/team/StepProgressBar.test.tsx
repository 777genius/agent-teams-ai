import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StepProgressBar } from '@renderer/components/team/StepProgressBar';

import type { StepProgressBarStep } from '@renderer/components/team/StepProgressBar';
import type { Root } from 'react-dom/client';

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    Check: Icon,
    X: Icon,
  };
});

const STEPS: StepProgressBarStep[] = [
  { key: 'starting', label: 'Starting' },
  { key: 'setup', label: 'Team setup' },
  { key: 'joining', label: 'Members joining' },
  { key: 'finalizing', label: 'Finalizing' },
];

function hasInlineAnimation(host: HTMLElement, animationName: string): boolean {
  return Array.from(host.querySelectorAll<HTMLElement>('[style]')).some((node) =>
    (node.getAttribute('style') ?? '').includes(animationName)
  );
}

function waitForTimerTick(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function renderStepper(
  props: React.ComponentProps<typeof StepProgressBar>
): Promise<{ host: HTMLDivElement; root: Root }> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(React.createElement(StepProgressBar, props));
    await Promise.resolve();
  });

  return { host, root };
}

describe('StepProgressBar', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('animates the current step and next connector while active', async () => {
    const { host, root } = await renderStepper({
      steps: STEPS,
      currentIndex: 2,
      active: true,
    });

    expect(hasInlineAnimation(host, 'stepper-pulse-ring')).toBe(true);
    expect(hasInlineAnimation(host, 'stepper-line-sweep')).toBe(true);
    expect(host.textContent).toContain('Members joining');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps the current marker but stops progress animations when settled', async () => {
    const { host, root } = await renderStepper({
      steps: STEPS,
      currentIndex: 2,
      active: false,
    });

    expect(host.textContent).toContain('3');
    expect(host.textContent).toContain('Members joining');
    expect(hasInlineAnimation(host, 'stepper-pulse-ring')).toBe(false);
    expect(hasInlineAnimation(host, 'stepper-line-sweep')).toBe(false);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('plays completion animations when an active launch advances steps', async () => {
    const { host, root } = await renderStepper({
      steps: STEPS,
      currentIndex: 1,
      active: true,
    });

    await act(async () => {
      root.render(
        React.createElement(StepProgressBar, {
          steps: STEPS,
          currentIndex: 2,
          active: true,
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      await waitForTimerTick();
    });

    expect(hasInlineAnimation(host, 'stepper-flash')).toBe(true);
    expect(hasInlineAnimation(host, 'stepper-jelly')).toBe(true);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not play completion animations for an inactive terminal update', async () => {
    const { host, root } = await renderStepper({
      steps: STEPS,
      currentIndex: 1,
      active: true,
    });

    await act(async () => {
      root.render(
        React.createElement(StepProgressBar, {
          steps: STEPS,
          currentIndex: 2,
          active: false,
        })
      );
      await Promise.resolve();
    });

    expect(hasInlineAnimation(host, 'stepper-flash')).toBe(false);
    expect(hasInlineAnimation(host, 'stepper-jelly')).toBe(false);
    expect(hasInlineAnimation(host, 'stepper-pulse-ring')).toBe(false);
    expect(hasInlineAnimation(host, 'stepper-line-sweep')).toBe(false);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
