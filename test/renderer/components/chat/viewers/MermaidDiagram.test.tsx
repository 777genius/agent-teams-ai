import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const render = vi.hoisted(() => vi.fn());
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render } }));
vi.mock('dompurify', () => ({ default: { sanitize: (svg: string) => svg } }));
import { MermaidDiagram } from '@renderer/components/chat/viewers/MermaidDiagram';

it('recovers from a partial parse error when the same message receives a valid diagram', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  render.mockRejectedValueOnce(new Error('Incomplete edge')).mockResolvedValueOnce({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Complete diagram</text></svg>',
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<MermaidDiagram code="graph TD; A-->" />);
  });
  expect(host.querySelector('pre')?.textContent).toContain('A-->');
  await act(async () => {
    root.render(<MermaidDiagram code="graph TD; A-->B;" />);
  });
  expect(host.querySelector('svg')).not.toBeNull();
  expect(host.textContent).toContain('Complete diagram');
  expect(host.querySelector('pre')).toBeNull();
  await act(async () => {
    root.unmount();
  });
  host.remove();
});
