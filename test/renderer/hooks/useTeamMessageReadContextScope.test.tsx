import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useTeamMessageReadContextScope } from '@renderer/hooks/useTeamMessageReadContextScope';
import { invalidateContextScopedRequestEpoch } from '@renderer/store/utils/contextScopedRequestEpoch';
import { expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ getClaudeRootInfo: vi.fn() }));
vi.mock('@renderer/api', () => ({ api: { config } }));

it('rejects a stale local root response even when the context ID stays local', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  type Info = { defaultPath: string; resolvedPath: string; customPath: string | null };
  let resolveOld!: (info: Info) => void;
  let resolveNew!: (info: Info) => void;
  config.getClaudeRootInfo
    .mockImplementationOnce(() => new Promise<Info>((resolve) => { resolveOld = resolve; }))
    .mockImplementationOnce(() => new Promise<Info>((resolve) => { resolveNew = resolve; }));
  let view: ReturnType<typeof useTeamMessageReadContextScope>;
  function Harness() {
    view = useTeamMessageReadContextScope('local');
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    invalidateContextScopedRequestEpoch();
    await act(async () => root.render(<Harness />));
    expect(view!.scope).toBeNull();
    await act(async () => invalidateContextScopedRequestEpoch());
    expect(view!.scope).toBeNull();
    await act(async () => resolveNew({
      defaultPath: '/default', resolvedPath: '/new', customPath: '/new',
    }));
    expect(view!.scope).toBe(JSON.stringify(['local-root', '/new']));
    await act(async () => resolveOld({
      defaultPath: '/default', resolvedPath: '/old', customPath: '/old',
    }));
    expect(view!.scope).toBe(JSON.stringify(['local-root', '/new']));
    expect(config.getClaudeRootInfo).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    config.getClaudeRootInfo.mockReset();
    vi.unstubAllGlobals();
  }
});
