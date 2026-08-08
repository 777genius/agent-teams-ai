import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  type HostedRuntimeAuthority,
  mountHostedRuntimeAuthority as mountFeatureHostedRuntimeAuthority,
} from '@features/team-runtime-control/main';

export type TeamProvisioningHostedRuntimeAuthority = HostedRuntimeAuthority;

/** Mounts Team Provisioning's singleton through the feature's public main composition surface. */
export function mountHostedRuntimeAuthority(target: {
  hostedRuntimeAuthority?: TeamProvisioningHostedRuntimeAuthority;
}): TeamProvisioningHostedRuntimeAuthority {
  return mountFeatureHostedRuntimeAuthority(target, {
    randomUuid: randomUUID,
    randomBytes,
    base64UrlEncode: (value) => Buffer.from(value).toString('base64url'),
    secureEqual: (left, right) => {
      const leftBytes = Buffer.from(left);
      const rightBytes = Buffer.from(right);
      return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
    },
  });
}
