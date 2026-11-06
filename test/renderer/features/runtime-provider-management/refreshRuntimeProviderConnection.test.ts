import { describe, expect, it } from 'vitest';

import { refreshRuntimeProviderConnection } from '../../../../src/features/runtime-provider-management/renderer/hooks/refreshRuntimeProviderConnection';

function deferredBoolean(): {
  promise: Promise<boolean>;
  resolve: (value: boolean) => void;
} {
  let complete!: (value: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: (value) => complete(value) };
}

describe('refreshRuntimeProviderConnection', () => {
  it('waits for both the provider view and directory before reporting refresh complete', async () => {
    const view = deferredBoolean();
    const directory = deferredBoolean();

    const refresh = refreshRuntimeProviderConnection({
      runtimeId: 'opencode',
      projectPath: '/tmp/TEST-project',
      runtimeRevision: null,
      directorySupported: false,
      isContextCurrent: () => true,
      isRuntimeRevisionCurrent: () => true,
      refreshExternal: async () => undefined,
      refreshView: () => view.promise,
      refreshDirectory: () => directory.promise,
    });

    let completed = false;
    void refresh.then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    view.resolve(true);
    await Promise.resolve();
    expect(completed).toBe(false);
    directory.resolve(true);

    expect(await refresh).toBe('refreshed');
    expect(completed).toBe(true);
  });
});
