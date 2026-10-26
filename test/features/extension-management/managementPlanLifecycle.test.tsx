import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useManagedExtensions } from '../../../src/features/extension-management/renderer/hooks/useManagedExtensions';

import type {
  ExtensionContext,
  ExtensionManagementAPI,
  ExtensionSelection,
  ManagementEnvironment,
  ManagementOperation,
  ManagementPlan,
} from '../../../src/features/extension-management/contracts';
import type { ManagedExtensionsModel } from '../../../src/features/extension-management/renderer/hooks/useManagedExtensions';

const backend = vi.hoisted(() => ({
  hostStatus: vi.fn(async () => ({ available: true })),
  capture: vi.fn<ExtensionManagementAPI['capture']>(),
  catalog: vi.fn<ExtensionManagementAPI['catalog']>(),
  environment: vi.fn<ExtensionManagementAPI['environment']>(),
  prepare: vi.fn<ExtensionManagementAPI['prepare']>(),
  prepareLocalSkill: vi.fn<ExtensionManagementAPI['prepareLocalSkill']>(),
  discardPlan: vi.fn<ExtensionManagementAPI['discardPlan']>(),
  apply: vi.fn<ExtensionManagementAPI['apply']>(),
}));
vi.mock('@renderer/api', () => ({ api: { extensionManagement: backend } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function captured(selection: ExtensionSelection): ExtensionContext {
  return {
    contextId: selection.authoringRootId ? 'host-local-root' : `host-${selection.client}`,
    selection,
    label: selection.client,
    session: {
      apiVersion: 1,
      engineVersion: 'test',
      contextId: 'engine-context',
      environmentId: 'shared-environment',
      scope: 'user',
      targets: [
        {
          id: 'claude',
          client: 'claude',
          label: 'Claude',
          scope: 'user',
          displayPath: '/fixture/claude',
          available: true,
        },
      ],
      capabilities: [],
    },
  };
}

function review(planId: string): ManagementPlan {
  return {
    planId,
    contextId: 'engine-context',
    action: 'install',
    expiresAt: '2099-01-01T00:00:00Z',
    confirmable: true,
    actions: [],
    conflicts: [],
    warnings: [],
  };
}

function completed(input: Parameters<ExtensionManagementAPI['apply']>[0]): ManagementOperation {
  return {
    ...input,
    operationId: `operation-${input.planId}`,
    environmentId: 'shared-environment',
    action: 'install',
    state: 'succeeded',
    phase: 'complete',
    completed: 1,
    total: 1,
    items: [],
    diagnostics: [],
    createdAt: '2026-10-26T00:00:00Z',
    updatedAt: '2026-10-26T00:00:00Z',
  };
}

const emptyEnvironment: ManagementEnvironment = {
  contextId: 'engine-context',
  entries: [],
  diagnostics: [],
};
const install = { action: 'install', source: 'publisher/lifecycle' } as const;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  backend.hostStatus.mockResolvedValue({ available: true });
  backend.capture.mockImplementation(async (selection) => captured(selection));
  backend.catalog.mockResolvedValue({ items: [], freshness: 'current', diagnostics: [] });
  backend.environment.mockResolvedValue(emptyEnvironment);
  backend.discardPlan.mockResolvedValue(undefined);
  backend.apply.mockImplementation(async (input) => completed(input));
});
afterEach(() => vi.unstubAllGlobals());

async function mount() {
  let current: ManagedExtensionsModel;
  let mounted = true;
  function Harness({ kind }: { kind: 'plugin' | 'skill' }) {
    current = useManagedExtensions(kind);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Harness key="plugin" kind="plugin" />));
  return {
    model: () => current!,
    selectSkills: async () => act(async () => root.render(<Harness key="skill" kind="skill" />)),
    close: async () => {
      if (!mounted) return;
      mounted = false;
      await act(async () => root.unmount());
    },
  };
}

it.each(['context', 'tab', 'unmount'] as const)(
  'discards a late prepared plan through its captured context after %s navigation',
  async (navigation) => {
    const late = deferred<ManagementPlan>();
    backend.prepare.mockReturnValueOnce(late.promise).mockResolvedValueOnce(review('new-review'));
    const view = await mount();
    try {
      let preparing!: Promise<boolean>;
      await act(async () => {
        preparing = view.model().prepare(install);
      });
      if (navigation === 'context') await act(async () => view.model().setClient('codex'));
      else if (navigation === 'tab') await view.selectSkills();
      else await view.close();
      if (navigation !== 'unmount') {
        await act(async () => {
          await view.model().prepare(install);
        });
        expect(view.model().plan?.planId).toBe('new-review');
      }
      await act(async () => {
        late.resolve(review('abandoned-review'));
        expect(await preparing).toBe(false);
      });
      expect(backend.discardPlan).toHaveBeenCalledExactlyOnceWith({
        contextId: 'host-claude',
        planId: 'abandoned-review',
      });
      expect(backend.apply).not.toHaveBeenCalled();
      if (navigation !== 'unmount') {
        expect(view.model().plan?.planId).toBe('new-review');
        expect(view.model().error).toBeNull();
        expect(view.model().busy).toBe(false);
      }
    } finally {
      await view.close();
    }
  }
);

it('discards a late local restore through the separate authoring context that prepared it', async () => {
  const late = deferred<ManagementPlan>();
  backend.prepareLocalSkill.mockReturnValue(late.promise);
  const view = await mount();
  try {
    let restoring!: Promise<void>;
    await act(async () => {
      restoring = view.model().restoreLocal('local-root', 'demo', 'restore-operation');
    });
    expect(backend.prepareLocalSkill).toHaveBeenCalledWith({
      contextId: 'host-local-root',
      change: {
        action: 'restore',
        rootId: 'local-root',
        skillName: 'demo',
        restoreOperationId: 'restore-operation',
      },
    });
    await act(async () => view.model().setClient('codex'));
    await act(async () => {
      late.resolve({ ...review('local-review'), action: 'local_skill' });
      await restoring;
    });
    expect(backend.discardPlan).toHaveBeenCalledExactlyOnceWith({
      contextId: 'host-local-root',
      planId: 'local-review',
    });
    expect(view.model().context?.contextId).toBe('host-codex');
    expect(view.model().plan).toBeNull();
    expect(backend.apply).not.toHaveBeenCalled();
  } finally {
    await view.close();
  }
});

it.each([false, true])(
  'preserves a newer uncertain Apply identity when stale cleanup fails: %s',
  async (cleanupFails) => {
    const late = deferred<ManagementPlan>();
    const currentReview = review('current-review');
    backend.prepare.mockReturnValueOnce(late.promise).mockResolvedValueOnce(currentReview);
    let uncertain: Parameters<ExtensionManagementAPI['apply']>[0] | undefined;
    backend.apply.mockImplementationOnce(async (input) => {
      uncertain = input;
      throw new Error('Apply reply was lost');
    });
    backend.environment.mockImplementation(async () => ({
      ...emptyEnvironment,
      uncertainApplications: uncertain ? [{ ...uncertain, plan: currentReview }] : [],
    }));
    const view = await mount();
    try {
      let preparing!: Promise<boolean>;
      await act(async () => {
        preparing = view.model().prepare(install);
      });
      await act(async () => view.model().setClient('codex'));
      await act(async () => {
        await view.model().prepare(install);
      });
      await act(async () => {
        await view.model().apply();
        await view.model().closeReview();
      });
      expect(view.model().reviewUncertain).toBe(true);
      const accepted = backend.apply.mock.calls[0][0];
      expect(accepted).toEqual({
        contextId: 'host-codex',
        planId: 'current-review',
        requestId: expect.any(String),
      });
      if (cleanupFails)
        backend.discardPlan.mockRejectedValueOnce(new Error('Discard reply was lost'));
      await act(async () => {
        late.resolve(review('abandoned-review'));
        expect(await preparing).toBe(false);
      });
      expect(backend.discardPlan).toHaveBeenCalledExactlyOnceWith({
        contextId: 'host-claude',
        planId: 'abandoned-review',
      });
      expect(view.model().plan).toBe(currentReview);
      expect(view.model().reviewUncertain).toBe(true);
      expect(view.model().error).toBe('Apply reply was lost');
      backend.apply.mockImplementationOnce(async (input) => {
        uncertain = undefined;
        return completed(input);
      });
      await act(async () => {
        await view.model().apply();
      });
      expect(backend.apply.mock.calls[1][0]).toEqual(accepted);
    } finally {
      await view.close();
    }
  }
);

it('keeps an attempted Apply owned by the backend when its hook unmounts before the reply', async () => {
  backend.prepare.mockResolvedValue(review('applying-review'));
  const applied = deferred<ManagementOperation>();
  backend.apply.mockReturnValue(applied.promise);
  const view = await mount();
  try {
    await act(async () => {
      await view.model().prepare(install);
    });
    let applying!: Promise<void>;
    await act(async () => {
      applying = view.model().apply();
    });
    const accepted = backend.apply.mock.calls[0][0];
    await view.close();
    await act(async () => {
      applied.resolve(completed(accepted));
      await applying;
    });
    expect(backend.discardPlan).not.toHaveBeenCalled();
    expect(backend.apply).toHaveBeenCalledExactlyOnceWith(accepted);
  } finally {
    await view.close();
  }
});
