import { DataCache } from '@main/services/infrastructure/DataCache';

import type { DetailReadAdapterLifetime } from './DetailReadAdapterLifetime';
import type { ServiceContext } from '@main/services/infrastructure/ServiceContext';
import type { SessionDetail } from '@main/types';

export async function readSessionDetail(
  context: ServiceContext,
  adapter: DetailReadAdapterLifetime,
  projectId: string,
  sessionId: string,
  bypassCache: boolean
): Promise<SessionDetail | null> {
  const source = context.getDetailReadSource();
  if (!adapter.isCurrent() || !context.isDetailReadSourceCurrent(source)) return null;
  const { projectScanner, sessionParser, subagentResolver, chunkBuilder, dataCache } = context;
  const key = DataCache.buildKey(projectId, sessionId);
  const cached = bypassCache ? undefined : dataCache.get(key);
  if (cached) return cached;
  const untrack = adapter.track(context.sessionDetailReads);
  try {
    const subscription = context.sessionDetailReads.subscribe({
      key,
      source,
      owner: adapter,
      fresh: bypassCache,
      prepare: () => {
        const fill = dataCache.beginSessionFill(projectId, sessionId);
        const isCurrent = (): boolean =>
          context.isDetailReadSourceCurrent(source) && fill.isSourceCurrent();
        const metadataLevel =
          projectScanner.getFileSystemProvider().type === 'ssh' ? 'light' : 'deep';
        return {
          isCurrent,
          release: () => fill.release(),
          execute: async () => {
            if (!isCurrent()) return null;
            const session = await projectScanner.getSessionWithOptions(projectId, sessionId, {
              metadataLevel,
            });
            if (!session || !isCurrent()) return null;
            const parsed = await sessionParser.parseSession(projectId, sessionId);
            if (!isCurrent()) return null;
            const subagents = await subagentResolver.resolveSubagents(
              projectId,
              sessionId,
              parsed.taskCalls,
              parsed.messages
            );
            if (!isCurrent()) return null;
            session.hasSubagents = subagents.length > 0;
            const detail = chunkBuilder.buildSessionDetail(session, parsed.messages, subagents);
            fill.commit(detail);
            return detail;
          },
        };
      },
    });
    const outcome = await subscription.result;
    if (!adapter.isCurrent() || !context.isDetailReadSourceCurrent(source)) return null;
    if (outcome.status === 'failure') throw outcome.error;
    return outcome.status === 'success' ? outcome.value : null;
  } finally {
    untrack();
  }
}
