import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  deleteTemplate: vi.fn(),
  duplicateTemplate: vi.fn(),
  copyBuiltinTemplate: vi.fn(),
}));
vi.mock('@renderer/api', () => ({ api: { customTeamTemplates: transport } }));
import {
  getPendingTemplateMutations,
  resolveTemplateMutation,
  setPendingTemplateMutation,
} from './pendingTemplateMutation';
import { useTemplateManagement } from './useTemplateManagement';

import type { CustomTeamTemplateV1 } from '../../contracts';

const template: CustomTeamTemplateV1 = {
  templateId: 'copy-id',
  name: 'Copy',
  schemaVersion: 1,
  teamPrompt: 'Prompt',
  members: [],
  revision: 1,
};
let latest!: ReturnType<typeof useTemplateManagement>;
let root: ReturnType<typeof createRoot>;
const onSuccess = vi.fn();
const Probe = (): null => {
  latest = useTemplateManagement({ onSuccess });
  return null;
};
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  for (const method of Object.values(transport)) method.mockReset();
  onSuccess.mockReset();
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root.render(React.createElement(Probe));
  });
});
afterEach(() => {
  act(() => root.unmount());
  setPendingTemplateMutation(null);
  vi.unstubAllGlobals();
});

describe('template management single-flight mutations', () => {
  it.each(['delete', 'duplicate', 'copyBuiltin'] as const)(
    'recognizes a later decision for an unknown %s',
    async (kind) => {
      const method =
        kind === 'delete'
          ? transport.deleteTemplate
          : kind === 'duplicate'
            ? transport.duplicateTemplate
            : transport.copyBuiltinTemplate;
      method.mockResolvedValueOnce({ status: 'unresolvedWriteOutcome', templateId: 'x' });
      await act(async () => {
        if (kind === 'delete')
          await latest.deleteTemplate({ templateId: 'source', expectedRevision: 1 });
        else if (kind === 'duplicate') await latest.duplicateTemplate('source', 'Copy');
        else await latest.copyBuiltinTemplate('software-product', 'Copy');
      });
      expect(latest.resolvedElsewhere).toBe(false);
      const old = getPendingTemplateMutations()[0];
      await act(async () => {
        expect(resolveTemplateMutation(old)).toBe(true);
      });
      expect(latest.resolvedElsewhere).toBe(true);
      expect(method).toHaveBeenCalledTimes(1);
    }
  );
  it.each([
    ['delete', 'unresolved'],
    ['delete', 'rejected'],
    ['duplicate', 'unresolved'],
    ['duplicate', 'rejected'],
    ['copyBuiltin', 'unresolved'],
    ['copyBuiltin', 'rejected'],
  ] as const)('retains the decision after a late %s %s response', async (kind, outcome) => {
    const method =
      kind === 'delete'
        ? transport.deleteTemplate
        : kind === 'duplicate'
          ? transport.duplicateTemplate
          : transport.copyBuiltinTemplate;
    let resolveWrite!: (value: { status: 'unresolvedWriteOutcome'; templateId: string }) => void;
    let rejectWrite!: (error: Error) => void;
    method.mockReturnValueOnce(
      new Promise((resolve, reject) => {
        resolveWrite = resolve;
        rejectWrite = reject;
      })
    );
    let pending!: Promise<unknown>;
    await act(async () => {
      pending =
        kind === 'delete'
          ? latest.deleteTemplate({ templateId: 'source', expectedRevision: 1 })
          : kind === 'duplicate'
            ? latest.duplicateTemplate('source', 'Copy')
            : latest.copyBuiltinTemplate('software-product', 'Copy');
    });
    const old = getPendingTemplateMutations()[0];
    await act(async () => {
      expect(resolveTemplateMutation(old)).toBe(true);
      setPendingTemplateMutation({ kind: 'edit', label: 'New action' });
    });
    await act(async () => {
      if (outcome === 'unresolved')
        resolveWrite({ status: 'unresolvedWriteOutcome', templateId: 'x' });
      else rejectWrite(new Error('lost response'));
      expect(await pending).toEqual({ status: 'resolvedElsewhere' });
    });
    expect(method).toHaveBeenCalledTimes(1);
    expect(getPendingTemplateMutations().map((item) => item.label)).toEqual(['New action']);
  });
  it('refuses a different overlapping request without changing the first result', async () => {
    let finish!: (value: { status: 'duplicated'; template: CustomTeamTemplateV1 }) => void;
    transport.duplicateTemplate.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    let first!: ReturnType<typeof latest.duplicateTemplate>;
    await act(async () => {
      first = latest.duplicateTemplate('source-id', 'Copy');
      expect(await latest.copyBuiltinTemplate('software-product', 'Other')).toEqual({
        status: 'storageUnavailable',
      });
    });
    expect(transport.copyBuiltinTemplate).not.toHaveBeenCalled();
    expect(latest.busy).toBe(true);
    await act(async () => {
      finish({ status: 'duplicated', template });
      expect(await first).toEqual({ status: 'duplicated', template });
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(latest.busy).toBe(false);
  });
  it.each(['delete', 'duplicate', 'copyBuiltin'] as const)(
    'refuses an overlapping %s without a second write or discarding the first result',
    async (operation) => {
      const method =
        operation === 'delete'
          ? transport.deleteTemplate
          : operation === 'duplicate'
            ? transport.duplicateTemplate
            : transport.copyBuiltinTemplate;
      const result =
        operation === 'delete'
          ? { status: 'deleted' as const, templateId: 'source-id' }
          : operation === 'duplicate'
            ? { status: 'duplicated' as const, template }
            : { status: 'copied' as const, template };
      let finish!: (value: typeof result) => void;
      method.mockReturnValueOnce(
        new Promise<typeof result>((resolve) => {
          finish = resolve;
        })
      );
      const invoke = () =>
        operation === 'delete'
          ? latest.deleteTemplate({ templateId: 'source-id', expectedRevision: 1 })
          : operation === 'duplicate'
            ? latest.duplicateTemplate('source-id', 'Copy')
            : latest.copyBuiltinTemplate('software-product', 'Copy');
      let first!: ReturnType<typeof invoke>;
      let second!: ReturnType<typeof invoke>;
      await act(async () => {
        first = invoke();
        second = invoke();
      });
      expect(method).toHaveBeenCalledTimes(1);
      expect(latest.busy).toBe(true);
      await act(async () => {
        finish(result);
        expect(await first).toEqual(result);
        expect(await second).toEqual({ status: 'storageUnavailable' });
      });
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(latest.busy).toBe(false);
    }
  );
});
