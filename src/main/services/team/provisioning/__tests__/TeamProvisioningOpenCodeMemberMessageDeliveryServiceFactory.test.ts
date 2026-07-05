import { tmpdir } from 'os';
import { describe, expect, it, vi } from 'vitest';

import {
  createOpenCodeMemberMessageDeliveryService,
  createOpenCodeMemberMessageDeliveryServiceFromHost,
  createOpenCodeRuntimeBootstrapEvidencePorts,
  deliverOpenCodeMemberMessage,
  type OpenCodeMemberMessageDeliveryFactoryPorts,
  type TeamProvisioningOpenCodeMemberMessageDeliveryHost,
} from '../TeamProvisioningOpenCodeMemberMessageDeliveryServiceFactory';

describe('TeamProvisioningOpenCodeMemberMessageDeliveryServiceFactory', () => {
  it('creates bootstrap evidence ports from explicit factory input', () => {
    const warn = vi.fn();
    const ports = createOpenCodeRuntimeBootstrapEvidencePorts({
      teamsBasePath: tmpdir(),
      warn,
    });

    expect(ports.teamsBasePath).toBe(tmpdir());
    expect(ports.warn).toBe(warn);
  });

  it('builds the delivery service and delegates delivery through the helper', async () => {
    const ports = {
      getOpenCodeRuntimeMessageAdapter: vi.fn(() => null),
      createOpenCodeRuntimeBootstrapEvidencePorts: vi.fn(() =>
        createOpenCodeRuntimeBootstrapEvidencePorts({
          teamsBasePath: tmpdir(),
          warn: vi.fn(),
        })
      ),
    } as unknown as OpenCodeMemberMessageDeliveryFactoryPorts;

    const service = createOpenCodeMemberMessageDeliveryService(ports);
    const delivery = await deliverOpenCodeMemberMessage(service, 'team-a', {
      memberName: 'Ada',
      text: 'hello',
    });

    expect(delivery).toEqual({
      delivered: false,
      reason: 'opencode_runtime_message_bridge_unavailable',
    });
    expect(ports.getOpenCodeRuntimeMessageAdapter).toHaveBeenCalledTimes(1);
    expect(ports.createOpenCodeRuntimeBootstrapEvidencePorts).not.toHaveBeenCalled();
  });

  it('creates the delivery service from a provisioning host boundary', async () => {
    const host = {
      getOpenCodeRuntimeMessageAdapter: vi.fn(() => null),
      createOpenCodeRuntimeBootstrapEvidencePorts: vi.fn(),
    } as unknown as TeamProvisioningOpenCodeMemberMessageDeliveryHost;

    const service = createOpenCodeMemberMessageDeliveryServiceFromHost(host);
    const delivery = await deliverOpenCodeMemberMessage(service, 'team-a', {
      memberName: 'Ada',
      text: 'hello',
    });

    expect(delivery).toEqual({
      delivered: false,
      reason: 'opencode_runtime_message_bridge_unavailable',
    });
    expect(host.getOpenCodeRuntimeMessageAdapter).toHaveBeenCalledTimes(1);
    expect(host.createOpenCodeRuntimeBootstrapEvidencePorts).not.toHaveBeenCalled();
  });
});
