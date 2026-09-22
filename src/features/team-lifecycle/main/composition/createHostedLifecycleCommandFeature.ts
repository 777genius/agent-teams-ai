import { ExecuteHostedLifecycleCommand } from '../../core/application/ExecuteHostedLifecycleCommand';
import { GetHostedLifecycleControlState } from '../../core/application/GetHostedLifecycleControlState';
import { GetHostedProvisioningStatus } from '../../core/application/GetHostedProvisioningStatus';
import { PrepareHostedProvisioning } from '../../core/application/PrepareHostedProvisioning';
import {
  HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS,
  type HostedLifecycleCommandHttpFacade,
} from '../adapters/input/http/registerHostedLifecycleCommandHttp';

import type { HostedLifecycleCommandGatewayPort } from '../../core/application/ports/HostedLifecycleCommandGatewayPort';
import type { HostedRouteContribution } from '@main/composition/hosted/application';

export interface HostedLifecycleCommandFeature extends HostedLifecycleCommandHttpFacade {
  readonly routes: typeof HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS;
}

export function createHostedLifecycleCommandFeature(dependencies: {
  readonly gateway: HostedLifecycleCommandGatewayPort;
  readonly now?: () => number;
}): HostedLifecycleCommandFeature {
  const execute = new ExecuteHostedLifecycleCommand(dependencies.gateway, dependencies.now);
  const getControlState = new GetHostedLifecycleControlState(
    dependencies.gateway,
    dependencies.now
  );
  const prepare = new PrepareHostedProvisioning(dependencies.gateway, dependencies.now);
  const getProgress = new GetHostedProvisioningStatus(dependencies.gateway, dependencies.now);
  return Object.freeze({
    routes: HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS,
    execute: execute.execute.bind(execute),
    getControlState: getControlState.execute.bind(getControlState),
    prepare: prepare.execute.bind(prepare),
    getProgress: getProgress.execute.bind(getProgress),
  });
}

export function createHostedLifecycleCommandRouteContribution(
  feature: HostedLifecycleCommandFeature
): HostedRouteContribution<HostedLifecycleCommandHttpFacade> {
  return Object.freeze({
    id: 'team-lifecycle.hosted-command.v1',
    facade: feature,
    routes: feature.routes,
  });
}
