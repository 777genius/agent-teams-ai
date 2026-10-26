import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useManagedExtensions } from '../../../src/features/extension-management/renderer/hooks/useManagedExtensions';

import type { ExtensionManagementAPI } from '../../../src/features/extension-management/contracts';
import type { ManagedExtensionsModel } from '../../../src/features/extension-management/renderer/hooks/useManagedExtensions';
import type { SkillImportRequest, SkillReviewPreview } from '../../../src/shared/types/extensions';

const backend = vi.hoisted(() => ({
  hostStatus: vi.fn(async () => ({ available: true })),
  capture: vi.fn(async () => ({
    contextId: 'host-a',
    selection: { client: 'claude', scope: 'user' },
  })),
  environment: vi.fn(async () => ({ contextId: 'engine-a', entries: [], diagnostics: [] })),
  catalog: vi.fn(async () => ({ items: [], freshness: 'current', diagnostics: [] })),
  skillCopySources: vi.fn(async () => []),
  previewSkillCopy: vi.fn<ExtensionManagementAPI['previewSkillCopy']>(),
  discardPlan: vi.fn<ExtensionManagementAPI['discardPlan']>(),
  apply: vi.fn(async () => ({ operationId: 'operation-a', state: 'succeeded' })),
}));
vi.mock('@renderer/api', () => ({ api: { extensionManagement: backend } }));

const request: SkillImportRequest = {
  sourceDir: '/fixture/source',
  folderName: 'copy',
  rootKind: 'claude',
  scope: 'user',
};
function preview(planId: string): SkillReviewPreview {
  return {
    planId,
    targetSkillDir: '/fixture/copy',
    changes: [],
    warnings: [],
    summary: { created: 0, updated: 0, deleted: 0, binary: 0 },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  backend.previewSkillCopy.mockReset();
  backend.discardPlan.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => vi.unstubAllGlobals());

async function mount() {
  let current: ManagedExtensionsModel;
  function Harness() {
    current = useManagedExtensions('skill');
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(React.createElement(Harness)));
  return { model: () => current!, close: async () => act(async () => root.unmount()) };
}

it('keeps a newer copy review applicable when an abandoned older preview arrives late', async () => {
  const first = deferred<SkillReviewPreview>();
  backend.previewSkillCopy.mockReturnValueOnce(first.promise).mockResolvedValueOnce(preview('b'));
  const view = await mount();
  try {
    let pending!: Promise<unknown>;
    await act(async () => {
      await view.model().loadCopySources('first');
      pending = view
        .model()
        .previewCopy('candidate-a', request)
        .catch((error: unknown) => error);
    });
    await act(async () => {
      await view.model().closeCopyReview();
      await view.model().loadCopySources('second');
      await view.model().previewCopy('candidate-b', request);
    });
    await act(async () => {
      first.resolve(preview('a'));
      await pending;
      await view.model().closeCopyReview('a');
    });
    expect(backend.discardPlan).toHaveBeenCalledExactlyOnceWith({
      contextId: 'host-a',
      planId: 'a',
    });
    await act(async () => {
      await view.model().applyCopy({ ...request, reviewPlanId: 'b' });
    });
    expect(backend.apply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ contextId: 'host-a', planId: 'b' })
    );
  } finally {
    await view.close();
  }
});

it('retries the same copy abandonment after a lost discard reply', async () => {
  backend.previewSkillCopy.mockResolvedValue(preview('copy-plan'));
  const view = await mount();
  try {
    await act(async () => {
      await view.model().loadCopySources('source');
      await view.model().previewCopy('candidate', request);
    });
    backend.discardPlan.mockRejectedValueOnce(new Error('discard reply lost'));
    await act(async () => {
      await expect(view.model().closeCopyReview('copy-plan')).rejects.toThrow('discard reply lost');
      await view.model().closeCopyReview('copy-plan');
    });
    expect(backend.discardPlan).toHaveBeenCalledTimes(2);
    expect(backend.discardPlan.mock.calls[0]).toEqual(backend.discardPlan.mock.calls[1]);
    expect(backend.apply).not.toHaveBeenCalled();
  } finally {
    await view.close();
  }
});

it('rejects Apply during copy abandonment and retains an uncertain Apply identity on close', async () => {
  backend.previewSkillCopy.mockResolvedValue(preview('copy-plan'));
  const view = await mount();
  try {
    await act(async () => {
      await view.model().loadCopySources('source');
      await view.model().previewCopy('candidate', request);
    });
    const discarded = deferred<void>();
    backend.discardPlan.mockReturnValueOnce(discarded.promise);
    let closing!: Promise<void>;
    await act(async () => {
      closing = view.model().closeCopyReview('copy-plan');
      await expect(
        view.model().applyCopy({ ...request, reviewPlanId: 'copy-plan' })
      ).rejects.toThrow();
    });
    expect(backend.apply).not.toHaveBeenCalled();
    await act(async () => {
      discarded.resolve();
      await closing;
      await view.model().previewCopy('candidate', request);
    });
    backend.discardPlan.mockClear();
    backend.apply.mockRejectedValueOnce(new Error('apply reply lost'));
    await act(async () => {
      await expect(
        view.model().applyCopy({ ...request, reviewPlanId: 'copy-plan' })
      ).rejects.toThrow('apply reply lost');
      await view.model().closeCopyReview('copy-plan');
      await view.model().applyCopy({ ...request, reviewPlanId: 'copy-plan' });
    });
    expect(backend.discardPlan).not.toHaveBeenCalled();
    expect(backend.apply.mock.calls[0]).toEqual(backend.apply.mock.calls[1]);
  } finally {
    await view.close();
  }
});
