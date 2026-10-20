import { describe, expect, it, vi } from 'vitest';

import { GATEWAY_PROVIDER_CHANNELS } from '../contracts';
import { registerGatewayProviderIpc } from '../main/adapters/input/registerGatewayProviderIpc';

import type { GatewayProviderFeatureFacade } from '../main/composition/createGatewayProviderFeature';
import type { IpcMain } from 'electron';

function setup() {
  const handlers = new Map<string, (event: unknown, request: unknown) => unknown>();
  const unbindGatewayMember = vi.fn(async () => undefined);
  registerGatewayProviderIpc(
    {
      handle: (name: string, handler: (event: unknown, request: unknown) => unknown) =>
        handlers.set(name, handler),
    } as unknown as IpcMain,
    { unbindGatewayMember } as unknown as GatewayProviderFeatureFacade
  );
  return {
    unbindGatewayMember,
    invoke: (request: unknown) =>
      handlers.get(GATEWAY_PROVIDER_CHANNELS.unbindMember)!(undefined, request),
  };
}

describe('gateway unbind IPC boundary', () => {
  it('retains the exact compare-and-delete receipt while stripping unrelated input', async () => {
    const { invoke, unbindGatewayMember } = setup();
    const expectedBinding = {
      gatewayUsageRef: 'usage-before',
      boundAt: '2026-10-20T00:00:00.000Z',
    };
    await invoke({
      teamName: 'sandbox',
      memberName: 'worker',
      expectedBinding: { ...expectedBinding, ignored: 'extra' },
      ignored: 'extra',
    });
    expect(unbindGatewayMember).toHaveBeenCalledExactlyOnceWith({
      teamName: 'sandbox',
      memberName: 'worker',
      expectedBinding,
    });
  });
  it('preserves explicit manual unbinding without a receipt', async () => {
    const { invoke, unbindGatewayMember } = setup();
    await invoke({ teamName: 'sandbox', memberName: 'worker' });
    expect(unbindGatewayMember).toHaveBeenCalledExactlyOnceWith({
      teamName: 'sandbox',
      memberName: 'worker',
    });
  });
  it.each([
    null,
    'receipt',
    {},
    { gatewayUsageRef: 'usage', boundAt: 42 },
    { gatewayUsageRef: '', boundAt: 'time' },
  ])('rejects an invalid receipt before touching the store: %j', (expectedBinding) => {
    const { invoke, unbindGatewayMember } = setup();
    expect(() => invoke({ teamName: 'sandbox', memberName: 'worker', expectedBinding })).toThrow();
    expect(unbindGatewayMember).not.toHaveBeenCalled();
  });
});
