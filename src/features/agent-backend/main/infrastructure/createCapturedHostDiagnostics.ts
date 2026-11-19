import { createHash } from 'node:crypto';

import { createLogger } from '@shared/utils/logger';

import { decodeClaudeCloseDiagnostics } from './decodeClaudeCloseDiagnostics';

/** Existing private Host stderr framing; observations never participate in Host custody. */
export function createCapturedHostDiagnostics(hostPid: () => number | undefined) {
  return decodeClaudeCloseDiagnostics(
    observation => {
      createLogger('Host:ClaudeClose').diagnostic('Claude close stage', observation);
    },
    observation => {
      createLogger('Host:ClaudeManagement').diagnostic('Claude management stage', observation);
    },
    observation => {
      const { startIdentity, ...fields } = observation;
      const pid = hostPid();
      if (pid !== undefined)
        createLogger('Host:OpenCodeMetadata').diagnostic('OpenCode metadata stage', {
          ...fields,
          ...(startIdentity === undefined ? {} : { startIdentityHash: createHash('sha256').update(startIdentity, 'utf8').digest('hex') }),
          hostPid: pid,
        });
    },
    observation => {
      const pid = hostPid();
      if (pid !== undefined)
        createLogger('Host:OpenCodeProbe').diagnostic('OpenCode probe phase', { ...observation, hostPid: pid });
    },
    observation => {
      const pid = hostPid();
      if (pid !== undefined)
        createLogger('Host:RuntimeOpen').diagnostic('Runtime open refusal', { ...observation, hostPid: pid });
    },
    observation => {
      const pid = hostPid();
      if (pid !== undefined)
        createLogger('Host:OpenCodeProbeClose').diagnostic('OpenCode probe close failure', { ...observation, hostPid: pid });
    }
  );
}
