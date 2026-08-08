import { createHash } from 'node:crypto';

import {
  type ApplicationCommandHasher,
  stableJsonStringify,
} from '@features/application-command-ledger';

export class NodeApplicationCommandHasher implements ApplicationCommandHasher {
  hashJson(value: unknown): string {
    return this.hashString(stableJsonStringify(value));
  }

  hashString(value: string): string {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
  }
}
