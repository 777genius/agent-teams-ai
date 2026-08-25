import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateMemberSettings = vi.hoisted(() => vi.fn());

import { useUpdateMemberSettings } from './useUpdateMemberSettings';

import type { EditableMemberSettings } from '../../contracts/memberSettings';

const baseSettings: EditableMemberSettings = {
  role: 'developer',
  workflow: null,
  isolation: null,
  providerId: null,
  providerBackendId: null,
  model: null,
  effort: null,
  fastMode: null,
  mcpPolicy: null,
};

const Harness = ({ settings }: { settings: EditableMemberSettings }): React.JSX.Element => {
  const { save } = useUpdateMemberSettings(updateMemberSettings);
  return (
    <button
      type="button"
      onClick={() =>
        void save({
          teamName: 'alpha',
          memberName: 'alice',
          expectedFingerprint: 'fingerprint',
          targetKind: 'member',
          settings,
        }).catch(() => undefined)
      }
    >
      save
    </button>
  );
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(globalThis.crypto, 'randomUUID')
    .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
    .mockReturnValueOnce('00000000-0000-4000-8000-000000000002');
  updateMemberSettings.mockRejectedValue(new Error('retryable'));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('useUpdateMemberSettings', () => {
  it('reuses identity only while retrying the same payload', async () => {
    act(() => root.render(<Harness settings={baseSettings} />));
    await act(async () => host.querySelector('button')?.click());
    await act(async () => host.querySelector('button')?.click());

    act(() => root.render(<Harness settings={{ ...baseSettings, role: 'reviewer' }} />));
    await act(async () => host.querySelector('button')?.click());

    expect(updateMemberSettings.mock.calls.map(([request]) => request.commandId)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ]);
  });
});
