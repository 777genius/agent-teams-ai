import { ExecuteHostedLifecycleCommand } from '../../core/application/ExecuteHostedLifecycleCommand';
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
  return Object.freeze({
    routes: HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS,
    execute: execute.execute.bind(execute),
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
