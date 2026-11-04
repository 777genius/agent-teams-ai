import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storeState = vi.hoisted(() => ({
  current: {
    cliProviderStatusScopeRevision: 0,
    openCodeRuntimeStatus: null as { version?: string } | null,
  },
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState.current) => unknown) =>
    selector(storeState.current),
}));
vi.mock('@renderer/hooks/useOpenCodePassiveStatusPrefetch', () => ({
  useOpenCodePassiveStatusPrefetch: () => undefined,
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./useOpenCodeDefaultRouteLabel', () => ({
  useOpenCodeProjectDefaultModel: () => ({ state: 'unknown' }),
}));

import { useOpenCodeProviderScopedDialogModelState } from './useOpenCodeProviderScopedModelAuthority';

import type { OpenCodeScopedPreparationEvidence } from '@renderer/utils/teamProviderRuntimeStatusLoading';

let evidence: OpenCodeScopedPreparationEvidence | null = null;

const Harness = (): null => {
  const { openCodePreparationEvidence } = useOpenCodeProviderScopedDialogModelState({
    projectPath: '/workspace/project',
    members: [],
    syncModelsWithLead: true,
    selectedProviderId: 'opencode',
    selectedModel: 'kimi-for-coding/kimi-for-coding',
    runtimeProviderStatusById: new Map(),
  });
  useEffect(() => {
    evidence = openCodePreparationEvidence;
  }, [openCodePreparationEvidence]);
  return null;
};

async function renderEvidence(
  version: string | undefined
): Promise<OpenCodeScopedPreparationEvidence | null> {
  storeState.current = {
    cliProviderStatusScopeRevision: 0,
    openCodeRuntimeStatus: version === undefined ? null : { version },
  };
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Harness />));
  await act(async () => root.unmount());
  return evidence;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  evidence = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useOpenCodeProviderScopedDialogModelState', () => {
  it('passes the installed OpenCode generation to the launch evidence', async () => {
    expect(await renderEvidence('2.1.4')).toMatchObject({
      selectedModels: ['kimi-for-coding/kimi-for-coding'],
      generation: 'v2',
    });
    expect((await renderEvidence('1.17.18'))?.generation).toBe('v1');
    expect((await renderEvidence(undefined))?.generation).toBe('v1');
  });
});
