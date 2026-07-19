import { createHash } from 'crypto';

import type { RuntimeRecoveryClockPort, RuntimeRecoveryHashPort } from '../../core/application';

export class SystemRuntimeRecoveryClock implements RuntimeRecoveryClockPort {
  now(): Date {
    return new Date();
  }
}

export class NodeRuntimeRecoveryHash implements RuntimeRecoveryHashPort {
  sha256Hex(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
