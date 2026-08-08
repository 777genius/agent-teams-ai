import { createHash } from 'node:crypto';

import type { ExternalContentChecksumPort } from '../../core/application';

export class NodeExternalContentChecksum implements ExternalContentChecksumPort {
  checksum(content: Uint8Array): string {
    return createHash('sha256').update(content).digest('hex');
  }
}
