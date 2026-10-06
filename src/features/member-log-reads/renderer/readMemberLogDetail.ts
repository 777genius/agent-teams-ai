import { api } from '@renderer/api';
import { asEnhancedChunkArray } from '@renderer/types/data';

import type { EnhancedChunk } from '@renderer/types/data';
import type { MemberLogSummary } from '@shared/types';

export async function readMemberLogDetail(
  log: MemberLogSummary,
  fresh: boolean
): Promise<EnhancedChunk[] | null> {
  const options = fresh ? { bypassCache: true } : undefined;
  if (log.kind === 'subagent') {
    const detail = await api.getSubagentDetail(
      log.projectId,
      log.sessionId,
      log.subagentId,
      options
    );
    return detail?.chunks ?? null;
  }
  const detail = await api.getSessionDetail(log.projectId, log.sessionId, options);
  return detail ? asEnhancedChunkArray(detail.chunks) : null;
}
