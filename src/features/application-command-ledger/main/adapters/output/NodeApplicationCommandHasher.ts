import { createHash } from 'node:crypto';

import { stableJsonStringify } from '../../../core/domain';

import type { ApplicationCommandHasher } from '../../../core/application';

export class NodeApplicationCommandHasher implements ApplicationCommandHasher {
  hashJson(value: unknown): string {
    return this.hashString(stableJsonStringify(value));
  }

  hashString(value: string): string {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
  }
}
