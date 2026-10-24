import { describe, expect, it } from 'vitest';

import { ExtensionRuntimeGate } from '../../../src/features/extension-management/core/application/ExtensionRuntimeGate';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
describe('native extension/runtime admission', () => {
  it('reserves a mutation before checking activity, closing the launch race', async () => {
    const gate = new ExtensionRuntimeGate(),
      check = deferred();
    const reservation = gate.reserveMutation(['profile-a'], () => check.promise);
    await expect(gate.launch(['profile-a'], async () => 'started')).rejects.toThrow(
      'extension change'
    );
    expect(await gate.launch(['profile-b'], async () => 'started')).toBe('started');
    check.release();
    (await reservation).release();
    expect(await gate.launch(['profile-a'], async () => 'started')).toBe('started');
  });
  it('refuses mutation while a matching launch is still preparing', async () => {
    const gate = new ExtensionRuntimeGate(),
      launch = deferred();
    const running = gate.launch(['profile-a'], () => launch.promise);
    await expect(gate.reserveMutation(['profile-a'], async () => {})).rejects.toThrow('busy');
    launch.release();
    await running;
    (await gate.reserveMutation(['profile-a'], async () => {})).release();
  });
  it('releases a refused mutation and makes release idempotent', async () => {
    const gate = new ExtensionRuntimeGate();
    await expect(
      gate.reserveMutation(['a'], async () => {
        throw new Error('active');
      })
    ).rejects.toThrow('active');
    const release = await gate.reserveMutation(['a'], async () => {});
    release.release();
    const second = await gate.reserveMutation(['a'], async () => {});
    release.release();
    await expect(gate.launch(['a'], async () => {})).rejects.toThrow('extension change');
    second.release();
  });
});
