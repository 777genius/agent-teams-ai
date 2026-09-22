import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useGraphInteraction, type UseGraphInteractionResult } from '../../../../packages/agent-graph/src/hooks/useGraphInteraction';

let firstInteraction: UseGraphInteractionResult | null = null;
let secondInteraction: UseGraphInteractionResult | null = null;

function InteractionHarness({ pass }: { pass: number }): React.JSX.Element | null {
  const interaction = useGraphInteraction();
  if (pass === 1) {
    firstInteraction = interaction;
  } else {
    secondInteraction = interaction;
  }
  return null;
}

describe('useGraphInteraction', () => {
  afterEach(() => {
    firstInteraction = null;
    secondInteraction = null;
    document.body.innerHTML = '';
  });

  it('returns a referentially stable result across rerenders', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(InteractionHarness, { pass: 1 }));
      await Promise.resolve();
    });

    await act(async () => {
      root.render(React.createElement(InteractionHarness, { pass: 2 }));
      await Promise.resolve();
    });

    expect(firstInteraction).toBeTruthy();
    expect(secondInteraction).toBe(firstInteraction);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
