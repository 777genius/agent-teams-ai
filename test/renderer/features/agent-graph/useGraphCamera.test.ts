import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useGraphCamera, type UseGraphCameraResult } from '../../../../packages/agent-graph/src/hooks/useGraphCamera';

import type { GraphNode } from '@claude-teams/agent-graph';

let capturedCamera: UseGraphCameraResult | null = null;
let firstCamera: UseGraphCameraResult | null = null;
let secondCamera: UseGraphCameraResult | null = null;

function CameraHarness(): React.JSX.Element | null {
  capturedCamera = useGraphCamera();
  return null;
}

function CameraIdentityHarness({ pass }: { pass: number }): React.JSX.Element | null {
  const camera = useGraphCamera();
  if (pass === 1) {
    firstCamera = camera;
  } else {
    secondCamera = camera;
  }
  return null;
}

describe('useGraphCamera zoomToFit', () => {
  afterEach(() => {
    capturedCamera = null;
    firstCamera = null;
    secondCamera = null;
    document.body.innerHTML = '';
  });

  it('accounts for extra world bounds when fitting the graph', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CameraHarness));
      await Promise.resolve();
    });

    const node: GraphNode = {
      id: 'lead:team-a',
      kind: 'lead',
      label: 'team-a',
      state: 'active',
      x: 0,
      y: 0,
      domainRef: { kind: 'lead', teamName: 'team-a', memberName: 'lead' },
    };

    capturedCamera?.zoomToFit([node], 800, 600);
    const zoomWithoutExtra = capturedCamera?.transformRef.current.zoom ?? 0;

    capturedCamera?.zoomToFit([node], 800, 600, [
      {
        left: 80,
        top: -50,
        right: 420,
        bottom: 120,
      },
    ]);

    const transform = capturedCamera?.transformRef.current;
    expect(transform).not.toBeNull();
    expect((transform?.zoom ?? 0)).toBeLessThan(zoomWithoutExtra);

    const right = 420 * (transform?.zoom ?? 0) + (transform?.x ?? 0);
    const bottom = 120 * (transform?.zoom ?? 0) + (transform?.y ?? 0);
    const left = 80 * (transform?.zoom ?? 0) + (transform?.x ?? 0);
    const top = -50 * (transform?.zoom ?? 0) + (transform?.y ?? 0);

    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(800);
    expect(bottom).toBeLessThanOrEqual(600);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('returns a referentially stable result across rerenders', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CameraIdentityHarness, { pass: 1 }));
      await Promise.resolve();
    });

    await act(async () => {
      root.render(React.createElement(CameraIdentityHarness, { pass: 2 }));
      await Promise.resolve();
    });

    expect(firstCamera).toBeTruthy();
    expect(secondCamera).toBe(firstCamera);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
