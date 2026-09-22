import { createHash } from 'crypto';

import type { MemberWorkSyncHashPort } from '../../core/application';

export class NodeHashAdapter implements MemberWorkSyncHashPort {
  sha256Hex(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
