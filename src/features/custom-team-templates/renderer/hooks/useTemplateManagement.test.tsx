import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  deleteTemplate: vi.fn(),
  duplicateTemplate: vi.fn(),
  copyBuiltinTemplate: vi.fn(),
}));
vi.mock('@renderer/api', () => ({ api: { customTeamTemplates: transport } }));
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
  vi.unstubAllGlobals();
});

describe('template management single-flight mutations', () => {
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
