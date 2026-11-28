import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useToolApprovalDiff } from '../../../src/renderer/hooks/useToolApprovalDiff';

import type { ToolApprovalFileContent,ToolApprovalReadScope } from '@shared/types/team';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@renderer/api', () => ({ api: { teams: { readFileForToolApproval: mocks.read } } }));
const cleanups: (() => void)[] = [];
beforeEach(() => {
  mocks.read.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop());
  vi.unstubAllGlobals();
});
const content = (text: string): ToolApprovalFileContent => ({
  content: text,
  exists: true,
  truncated: false,
  isBinary: false,
});
const scope = (teamName: string): ToolApprovalReadScope => ({
  teamName,
  requestId: 'TEST-same-request',
  runId: 'TEST-run',
});

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const Probe = ({ selected }: { selected: ToolApprovalReadScope }) => {
    const diff = useToolApprovalDiff(
      'Write',
      { file_path: '/TEST/captured/file.txt', content: 'TEST next' },
      selected.requestId,
      true,
      selected
    );
    return <pre>{JSON.stringify(diff)}</pre>;
  };
  return {
    host,
    render: async (selected: ToolApprovalReadScope) => {
      await act(async () => root.render(<Probe selected={selected} />));
    },
  };
}

it('the original diff hook carries the exact approval scope into the existing API control', async () => {
  mocks.read.mockResolvedValue(content('TEST dirty bytes'));
  const view = mount(),
    selected = scope('host-team:TEST-owner-A');
  await view.render(selected);
  expect(mocks.read).toHaveBeenCalledWith('/TEST/captured/file.txt', selected);
  expect(JSON.parse(view.host.textContent!)).toMatchObject({
    oldString: 'TEST dirty bytes',
    newString: 'TEST next',
    hasDiff: true,
    loading: false,
  });
});
it('a late read cannot publish across a changed owner even if a request label is reused', async () => {
  let first!: (value: ToolApprovalFileContent) => void,
    second!: (value: ToolApprovalFileContent) => void;
  mocks.read
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          first = resolve;
        })
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          second = resolve;
        })
    );
  const view = mount();
  await view.render(scope('host-team:TEST-owner-A'));
  await view.render(scope('host-team:TEST-owner-B'));
  await act(async () => second(content('TEST owner B')));
  expect(JSON.parse(view.host.textContent!).oldString).toBe('TEST owner B');
  await act(async () => first(content('TEST old owner A')));
  expect(JSON.parse(view.host.textContent!).oldString).toBe('TEST owner B');
});
