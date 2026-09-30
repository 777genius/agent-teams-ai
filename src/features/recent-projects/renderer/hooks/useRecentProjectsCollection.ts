import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  OpenResult,
  RecentProjectCardModel,
  RecentProjectIdentity,
} from '../ui/recentProjectsModel';

const INITIAL_VISIBLE = 11;
const LOAD_MORE_STEP = 8;

export interface RecentProjectsCollectionSource {
  scopeKey: string;
  readEpoch: number;
  rows: readonly RecentProjectCardModel[];
  completeness: 'complete' | 'partial';
  stale: boolean;
  openProject: (intent: RecentProjectIdentity) => Promise<OpenResult>;
  revealProject?: (intent: RecentProjectIdentity) => Promise<OpenResult>;
  extensionAction?: {
    label: string;
    ariaLabel: string;
    icon: 'folder' | 'workspaces';
    run: () => Promise<OpenResult>;
  };
}

export function useRecentProjectsCollection(
  source: RecentProjectsCollectionSource,
  searchQuery: string
) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [messageKey, setMessageKey] = useState<string | null>(null);
  const pendingRef = useRef<Set<string>>(new Set());
  const currentRef = useRef(source);
  currentRef.current = source;

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE);
    setMessage(null);
    setMessageKey(null);
    pendingRef.current.clear();
    setPendingKey(null);
  }, [source.scopeKey, source.readEpoch]);

  useEffect(() => {
    if (!searchQuery.trim()) setVisibleCount(INITIAL_VISIBLE);
  }, [searchQuery]);

  const filteredRows = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    return query
      ? source.rows.filter((row) =>
          [
            row.name,
            row.subtitle ?? '',
            row.branch.kind === 'known' ? row.branch.value : '',
            ...(row.desktopPathDetails?.map((detail) => detail.text) ?? []),
          ].some((value) => value.toLocaleLowerCase().includes(query))
        )
      : source.rows;
  }, [searchQuery, source.rows]);
  const rows = searchQuery.trim() ? filteredRows : filteredRows.slice(0, visibleCount);

  const run = useCallback(async (key: string, effect: () => Promise<OpenResult>) => {
    if (pendingRef.current.has(key)) return;
    const { scopeKey, readEpoch } = currentRef.current;
    const isCurrent = () =>
      currentRef.current.scopeKey === scopeKey && currentRef.current.readEpoch === readEpoch;
    pendingRef.current.add(key);
    setPendingKey(key);
    setMessage(null);
    setMessageKey(null);
    try {
      const result = await effect();
      if (!isCurrent()) return;
      if (result.kind === 'failed') {
        setMessage(result.message);
        setMessageKey(key);
      }
      if (result.kind === 'unavailable') {
        setMessage(result.reason);
        setMessageKey(key);
      }
      if (result.kind === 'stale_target') {
        setMessage('Project is no longer available. Refresh and try again.');
        setMessageKey(key);
      }
    } catch {
      if (isCurrent()) {
        setMessage('Could not open the project. Try again.');
        setMessageKey(key);
      }
    } finally {
      pendingRef.current.delete(key);
      if (isCurrent()) setPendingKey((current) => (current === key ? null : current));
    }
  }, []);

  const runIntent = useCallback(
    (intent: RecentProjectIdentity, kind: 'open' | 'reveal') => {
      const current = currentRef.current;
      if (intent.scopeKey !== current.scopeKey || intent.readEpoch !== current.readEpoch) return;
      const row = current.rows.find(
        (candidate) =>
          candidate.identity.scopeKey === intent.scopeKey &&
          candidate.identity.readEpoch === intent.readEpoch &&
          candidate.identity.targetKey === intent.targetKey
      );
      if (!row) return;
      const action = kind === 'open' ? row.open : row.reveal;
      if (action.support !== 'supported' || action.availability !== 'available') return;
      const effect = kind === 'open' ? current.openProject : current.revealProject;
      if (!effect) return;
      const key = `${kind}:${intent.scopeKey}:${intent.readEpoch}:${intent.targetKey}`;
      void run(key, () => effect(intent));
    },
    [run]
  );

  return {
    rows,
    canLoadMore: !searchQuery.trim() && filteredRows.length > visibleCount,
    loadMore: () => setVisibleCount((current) => current + LOAD_MORE_STEP),
    pendingKey,
    message,
    messageKey,
    openProject: (intent: RecentProjectIdentity) => runIntent(intent, 'open'),
    revealProject: (intent: RecentProjectIdentity) => runIntent(intent, 'reveal'),
    runExtension: () => {
      const current = currentRef.current;
      if (current.extensionAction) {
        void run(`extension:${current.scopeKey}:${current.readEpoch}`, current.extensionAction.run);
      }
    },
  };
}
