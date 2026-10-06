import type { DetailReadAdapterLifetime } from './DetailReadAdapterLifetime';
import type { ServiceContext } from '@main/services/infrastructure/ServiceContext';
import type { SubagentDetail } from '@main/types';

export async function readSubagentDetail(
  context: ServiceContext,
  adapter: DetailReadAdapterLifetime,
  projectId: string,
  sessionId: string,
  subagentId: string,
  bypassCache: boolean
): Promise<SubagentDetail | null> {
  const source = context.getDetailReadSource();
  if (!adapter.isCurrent() || !context.isDetailReadSourceCurrent(source)) return null;
  const { chunkBuilder, sessionParser, subagentResolver, projectScanner, dataCache } = context;
  const key = `subagent-${projectId}-${sessionId}-${subagentId}`;
  const cached = bypassCache ? undefined : dataCache.getSubagent(key);
  if (cached) return cached;
  const fsProvider = projectScanner.getFileSystemProvider();
  const projectsDir = projectScanner.getProjectsDir();
  const untrack = adapter.track(context.subagentDetailReads);
  try {
    const subscription = context.subagentDetailReads.subscribe({
      key: JSON.stringify([projectId, sessionId, subagentId]),
      source,
      owner: adapter,
      fresh: bypassCache,
      prepare: () => {
        const fill = dataCache.beginSubagentFill(projectId, sessionId, subagentId);
        const isCurrent = (): boolean =>
          context.isDetailReadSourceCurrent(source) && fill.isSourceCurrent();
        return {
          isCurrent,
          release: () => fill.release(),
          execute: async () => {
            if (!isCurrent()) return null;
            const detail = await chunkBuilder.buildSubagentDetail(
              projectId,
              sessionId,
              subagentId,
              sessionParser,
              subagentResolver,
              fsProvider,
              projectsDir
            );
            if (!isCurrent()) return null;
            if (detail) fill.commit(detail);
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
