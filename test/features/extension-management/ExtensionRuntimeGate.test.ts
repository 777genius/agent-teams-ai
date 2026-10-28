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
  it('widens a fresh recovery fence before any new profile can launch', () => {
    const gate = new ExtensionRuntimeGate();
    const lease = gate.restoreMutation(['profile-a']);
    lease.extend(['profile-a', 'profile-b'], true);
    return expect(gate.launch(['profile-b'], async () => 'started')).rejects.toThrow(
      'extension change'
    );
  });
  it('refuses fresh recovery while a launch is preparing, including an already restored resource', async () => {
    const gate = new ExtensionRuntimeGate();
    const launch = deferred();
    const preparing = gate.launch(['profile-b'], () => launch.promise);
    const lease = gate.restoreMutation(['profile-a']);
    expect(() => lease.extend(['profile-a', 'profile-b'], true)).toThrow('busy');
    lease.extend(['profile-b']); // Observing already accepted work still fences future launches.
    expect(() => lease.extend(['profile-b'], true)).toThrow('busy');
    launch.release();
    await preparing;
    lease.extend(['profile-a', 'profile-b'], true);
    lease.release();
  });
  it('returns the owned mutation lease synchronously before validation can await', async () => {
    const gate = new ExtensionRuntimeGate();
    const reservation = gate.reserveMutation(['profile-a']);
    await expect(gate.launch(['profile-a'], async () => 'started')).rejects.toThrow(
      'extension change'
    );
    expect(await gate.launch(['profile-b'], async () => 'started')).toBe('started');
    reservation.release();
    expect(await gate.launch(['profile-a'], async () => 'started')).toBe('started');
  });
  it('refuses mutation while a matching launch is still preparing', async () => {
    const gate = new ExtensionRuntimeGate(),
      launch = deferred();
    const running = gate.launch(['profile-a'], () => launch.promise);
    expect(() => gate.reserveMutation(['profile-a'])).toThrow('busy');
    launch.release();
    await running;
    gate.reserveMutation(['profile-a']).release();
  });
  it('keeps release idempotent without clearing a later reservation', async () => {
    const gate = new ExtensionRuntimeGate();
    const release = gate.reserveMutation(['a']);
    release.release();
    const second = gate.reserveMutation(['a']);
    release.release();
    await expect(gate.launch(['a'], async () => {})).rejects.toThrow('extension change');
    second.release();
  });
});
