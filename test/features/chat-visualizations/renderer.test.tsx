import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { describe, expect, it, vi } from 'vitest';

import { OpenUIVisualization } from '../../../src/features/chat-visualizations/renderer/ui/OpenUIVisualization';

describe('actual display Renderer', () => {
  it('shows card/table text, escapes Markdown, and updates without treating cleared errors as failure', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onFailure = vi.fn();
    const text =
      '![image](https://example.test/img) [link](https://example.test) <script>bad()</script>';
    const source = (title: string) =>
      'root = Stack([Card([CardHeader(' +
      JSON.stringify(title) +
      '), TextContent(' +
      JSON.stringify(text) +
      '), Table([Col("Name", ["Alpha"], "string"), Col("Value", [10], "number")])])]);';
    try {
      await act(async () =>
        root.render(
          <OpenUIVisualization
            source={source('Report')}
            fenceState="closed"
            onFailure={onFailure}
          />
        )
      );
      expect(host.textContent).toContain('Report');
      expect(host.textContent).toContain('Alpha');
      expect(host.textContent).toContain('10');
      expect(host.textContent).toContain(text);
      expect(host.querySelector('img, a, script')).toBeNull();
      expect(onFailure).not.toHaveBeenCalled();
      await act(async () =>
        root.render(
          <OpenUIVisualization
            source={source('Updated')}
            fenceState="closed"
            onFailure={onFailure}
          />
        )
      );
      expect(host.textContent).toContain('Updated');
      expect(onFailure).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});
