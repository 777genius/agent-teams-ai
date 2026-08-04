import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useToolApprovalDiff } from './useToolApprovalDiff';

import type { ToolApprovalDiffData } from './useToolApprovalDiff';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const transportMock = vi.hoisted(() => ({
  readFile: vi.fn(),
}));

vi.mock('@renderer/composition/team/createTeamToolApprovalDiffFileReadTransport', () => ({
  createTeamToolApprovalDiffFileReadTransport: () => transportMock,
}));

interface ProbeProps {
  requestId: string;
  filePath: string;
  onRender(data: ToolApprovalDiffData): void;
}

const Probe: React.FC<ProbeProps> = ({ requestId, filePath, onRender }) => {
  const data = useToolApprovalDiff(
    'Write',
    { file_path: filePath, content: `next:${requestId}` },
    'team-one',
    'run-1',
    requestId,
    true
  );
  onRender(data);
  return null;
};

describe('useToolApprovalDiff approval identity', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    transportMock.readFile.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('never exposes the previous approval diff during the next approval render', async () => {
    let renders: ToolApprovalDiffData[] = [];
    transportMock.readFile.mockResolvedValueOnce({
      content: 'before:request-a',
      exists: true,
      truncated: false,
      isBinary: false,
    });

    await act(async () => {
      root.render(
        <Probe
          requestId="request-a"
          filePath="/workspace/a.txt"
          onRender={(data) => renders.push(data)}
        />
      );
      await Promise.resolve();
    });
    expect(renders.at(-1)).toMatchObject({
      oldString: 'before:request-a',
      newString: 'next:request-a',
    });

    renders = [];
    transportMock.readFile.mockReturnValueOnce(new Promise(() => undefined));
    await act(async () => {
      root.render(
        <Probe
          requestId="request-b"
          filePath="/workspace/b.txt"
          onRender={(data) => renders.push(data)}
        />
      );
    });

    expect(renders[0]).toMatchObject({
      oldString: '',
      newString: '',
      fileName: '',
    });
  });
});
