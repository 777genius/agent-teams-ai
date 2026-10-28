import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useManagedExtensions } from '../../../src/features/extension-management/renderer/hooks/useManagedExtensions';
import { ManagementPlanDialog } from '../../../src/features/extension-management/renderer/ui/ManagementPlanDialog';

import type {
  ExtensionManagementAPI,
  ManagementChange,
  ManagementPlan,
} from '../../../src/features/extension-management/contracts';
import type { ManagedExtensionsModel } from '../../../src/features/extension-management/renderer/hooks/useManagedExtensions';

const backend = vi.hoisted(() => ({
  hostStatus: vi.fn(async () => ({ available: true })),
  capture: vi.fn(async () => ({
    contextId: 'host-a',
    selection: { client: 'claude', scope: 'user' },
  })),
  environment: vi.fn(async () => ({ contextId: 'engine-a', entries: [], diagnostics: [] })),
  catalog: vi.fn(async () => ({ items: [], freshness: 'current', diagnostics: [] })),
  prepare: vi.fn<ExtensionManagementAPI['prepare']>(),
  discardPlan: vi.fn(async () => {}),
}));
vi.mock('@renderer/api', () => ({ api: { extensionManagement: backend } }));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

function review(id: string, confirmable = false): ManagementPlan {
  return {
    planId: id,
    contextId: 'engine-a',
    action: 'update',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    confirmable,
    actions: [],
    warnings: [],
    conflicts: confirmable
      ? []
      : [
          {
            code: 'EXTERNAL_UNINSTALL_REQUIRED',
            severity: 'error',
            alias: 'native-plugin',
            targetId: 'codex',
            message: 'Confirm removal in the native client.',
          },
        ],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  backend.prepare.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => vi.unstubAllGlobals());

describe('external native removal review', () => {
  it.each([
    { action: 'remove', aliases: ['native-plugin'] },
    { action: 'update', aliases: ['native-plugin'] },
    { action: 'recover', operationId: 'pending-native-removal' },
  ] satisfies ManagementChange[])(
    're-prepares the exact $action intent only after explicit attestation and does not retain the flag',
    async (change) => {
      backend.prepare
        .mockResolvedValueOnce(review('first'))
        .mockResolvedValueOnce(review('confirmed', true))
        .mockResolvedValueOnce(review('next', true));
      let current: ManagedExtensionsModel | undefined;
      function Harness() {
        current = useManagedExtensions('plugin');
        return null;
      }
      const root = createRoot(document.createElement('div'));
      try {
        await act(async () => {
          root.render(React.createElement(Harness));
        });
        await act(async () => {
          await current!.prepare(change);
        });
        expect(backend.prepare).toHaveBeenCalledTimes(1);
        expect(current!.canAttestExternalUninstall).toBe(true);
        const original = backend.prepare.mock.calls[0][0];
        expect(original.change.externalUninstalled).toBeUndefined();
        await act(async () => {
          await current!.attestExternalUninstall();
        });
        expect(backend.prepare.mock.calls[1][0]).toEqual({
          ...original,
          change: { ...original.change, externalUninstalled: true },
        });
        expect(current!.plan?.planId).toBe('confirmed');
        expect(backend.discardPlan).toHaveBeenCalledWith({ contextId: 'host-a', planId: 'first' });
        await act(async () => {
          await current!.prepare({ action: 'sync' });
        });
        expect(backend.prepare.mock.calls[2][0].change).toEqual({ action: 'sync' });
      } finally {
        await act(async () => root.unmount());
      }
    }
  );

  it('requires an unchecked explicit statement and a new review before Apply becomes available', async () => {
    const onAttest = vi.fn();
    const onApply = vi.fn();
    const root = createRoot(document.createElement('div'));
    const render = (plan: ManagementPlan) =>
      root.render(
        React.createElement(ManagementPlanDialog, {
          plan,
          busy: false,
          error: null,
          uncertain: false,
          onClose: () => {},
          onApply,
          onAttestExternalUninstall: onAttest,
        })
      );
    const findButton = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === label
      )!;
    try {
      await act(async () => {
        render(review('first'));
      });
      expect(document.body.textContent).toContain('native-plugin · codex');
      expect(findButton('uap.reviewExternalUninstall').disabled).toBe(true);
      expect(findButton('uap.apply').disabled).toBe(true);
      const checkbox = document.querySelector<HTMLButtonElement>('[role=checkbox]')!;
      expect(checkbox.getAttribute('data-state')).toBe('unchecked');
      await act(async () => {
        checkbox.click();
      });
      expect(findButton('uap.reviewExternalUninstall').disabled).toBe(false);
      await act(async () => {
        findButton('uap.reviewExternalUninstall').click();
      });
      expect(onAttest).toHaveBeenCalledOnce();
      expect(onApply).not.toHaveBeenCalled();
      await act(async () => {
        render(review('fresh-conflict'));
      });
      expect(findButton('uap.reviewExternalUninstall').disabled).toBe(true);
      await act(async () => {
        render(review('confirmed', true));
      });
      expect(document.querySelector('[role=checkbox]')).toBeNull();
      expect(findButton('uap.apply').disabled).toBe(false);
      expect(onApply).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
