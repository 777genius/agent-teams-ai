import { HostedTeamConfigurationAuthority } from '../../core/application/hosted-authority/HostedTeamConfigurationAuthority';
import { InternalStorageHostedTeamConfigurationStorageAdapter } from '../adapters/output/hosted-authority/InternalStorageHostedTeamConfigurationStorageAdapter';

import type { HostedTeamConfigurationApplicationPort } from '../ports/HostedTeamConfigurationAuthorizationPort';
import type { HostedTeamConfigurationStorageGateway } from '@features/internal-storage/contracts';

export function createHostedTeamConfigurationAuthority(
  storage: HostedTeamConfigurationStorageGateway
): HostedTeamConfigurationApplicationPort {
  return new HostedTeamConfigurationAuthority({
    storage: new InternalStorageHostedTeamConfigurationStorageAdapter(storage),
    sha256Hex: async (value) => {
      const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(value)
      );
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
        ''
      );
    },
    now: Date.now,
  });
}
