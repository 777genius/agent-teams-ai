import React, { act, Profiler } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MentionInteractionLayer } from './MentionInteractionLayer';

import type { MentionSuggestion } from '@renderer/types/mention';

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({
    theme: 'light',
    resolvedTheme: 'light',
    isDark: false,
    isLight: true,
  }),
}));

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const suggestion: MentionSuggestion = {
  id: 'member:alice',
  name: 'Alice',
  subtitle: 'Engineer',
  type: 'member',
};

describe('MentionInteractionLayer', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('does not schedule a nested update when suggestions exist but text has no mentions', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const renderPhases: string[] = [];

    const Harness = (): React.JSX.Element => {
      const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

      return (
        <>
          <textarea ref={textareaRef} defaultValue="" />
          <Profiler
            id="mention-interaction-layer"
            onRender={(_id, phase) => {
              renderPhases.push(phase);
            }}
          >
            <MentionInteractionLayer
              suggestions={[suggestion]}
              value=""
              textareaRef={textareaRef}
              scrollTop={0}
            />
          </Profiler>
        </>
      );
    };

    await act(async () => {
      root.render(<Harness />);
      await flushMicrotasks();
    });

    expect(renderPhases).toEqual(['mount']);

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });
});
