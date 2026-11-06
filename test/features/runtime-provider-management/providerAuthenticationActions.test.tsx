// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  invalidateContextScopedRequestEpoch,
  resetContextScopedRequestEpochForTests,
} from '@renderer/store/utils/contextScopedRequestEpoch';
import { afterEach, expect, it, vi } from 'vitest';

import { useProviderAuthenticationActions } from '../../../src/renderer/components/runtime/useProviderAuthenticationActions';

import type { CliProviderStatus } from '@shared/types';

const h = vi.hoisted(() => ({ setup: vi.fn(), confirm: vi.fn() }));
vi.mock('@renderer/api', () => ({
  api: { runtimeProviderManagement: { loadSetupForm: h.setup } },
}));
vi.mock('@renderer/components/common/ConfirmDialog', () => ({ confirm: h.confirm }));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
const provider = {
  providerId: 'anthropic',
  authenticated: true,
  authMethod: 'claude.ai',
  nativeAuthManagement: 'claude',
} as CliProviderStatus;
const hosts: { root: ReturnType<typeof createRoot>; host: HTMLDivElement }[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mount() {
  resetContextScopedRequestEpochForTests();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const native = vi.fn(),
    legacy = vi.fn();
  const host = document.createElement('div'),
    root = createRoot(host);
  hosts.push({ host, root });
  document.body.append(host);
  function Harness() {
    const request = useProviderAuthenticationActions({
      providers: [provider],
      projectPath: '/TEST/original-project',
      openNative: native,
      openLegacy: legacy,
    });
    return <button onClick={() => void request('anthropic', 'logout')}>Sign out</button>;
  }
  await act(async () => root.render(<Harness />));
  return {
    native,
    legacy,
    click: async () => {
      await act(async () => host.querySelector('button')!.click());
    },
  };
}
afterEach(async () => {
  for (const { root, host } of hosts.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it('captures the original account before existing confirmation and carries that token without a second selection', async () => {
  const form = deferred<unknown>(),
    confirm = deferred<boolean>();
  h.setup.mockReturnValue(form.promise);
  h.confirm.mockReturnValue(confirm.promise);
  const f = await mount();
  await f.click();
  expect(h.setup).toHaveBeenCalledWith({
    runtimeId: 'claude',
    providerId: 'anthropic',
    projectPath: '/TEST/original-project',
  });
  expect(h.setup.mock.invocationCallOrder[0]).toBeLessThan(h.confirm.mock.invocationCallOrder[0]!);
  expect(f.native).not.toHaveBeenCalled();
  await act(async () => {
    form.resolve({ setupForm: { connectionContextToken: 'TEST-original-account' } });
    confirm.resolve(true);
  });
  expect(f.native).toHaveBeenCalledWith('anthropic', {
    action: 'logout',
    projectPath: '/TEST/original-project',
    connectionContextToken: 'TEST-original-account',
  });
  expect(h.setup).toHaveBeenCalledTimes(1);
  expect(f.legacy).not.toHaveBeenCalled();
});
it('a context switch during confirmation cannot open or mutate the new foreground account', async () => {
  const confirmation = deferred<boolean>();
  h.setup.mockResolvedValue({ setupForm: { connectionContextToken: 'TEST-original-account' } });
  h.confirm.mockReturnValue(confirmation.promise);
  const f = await mount();
  await f.click();
  invalidateContextScopedRequestEpoch();
  await act(async () => confirmation.resolve(true));
  expect(f.native).not.toHaveBeenCalled();
  expect(f.legacy).not.toHaveBeenCalled();
  expect(h.setup).toHaveBeenCalledTimes(1);
});
it('cancelling confirmation performs only the captured read, with no terminal or new form', async () => {
  h.setup.mockResolvedValue({ setupForm: { connectionContextToken: 'TEST-original-account' } });
  h.confirm.mockResolvedValue(false);
  const f = await mount();
  await f.click();
  expect(f.native).not.toHaveBeenCalled();
  expect(f.legacy).not.toHaveBeenCalled();
  expect(h.setup).toHaveBeenCalledTimes(1);
});
