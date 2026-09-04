import { useCallback, useEffect, useRef, useState } from 'react';

import { getOverlaySnapshot, subscribeOverlayOccupancy } from '@renderer/hooks/useOverlayOccupancy';

import { subscribeAnnouncementHistory } from './newsNavigation';

import type { AnnouncementDocument, AnnouncementsApi, AnnouncementsSnapshot } from '../contracts';

type Mode = 'idle' | 'auto' | 'history';
const foreground = (): boolean => document.visibilityState === 'visible' && document.hasFocus();

export function useAnnouncementHost(client: AnnouncementsApi, ready: boolean) {
  const [mode, setMode] = useState<Mode>('idle');
  const [documentState, setDocument] = useState<AnnouncementDocument | null>(null);
  const [snapshot, setSnapshot] = useState<AnnouncementsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const lastSelection = useRef('');
  const state = useRef({
    mode: 'idle' as Mode,
    ready,
    alive: false,
    generation: 0,
    articleGeneration: 0,
    pending: false,
    retryRequested: false,
    manualRefreshes: 0,
    pendingClaim: null as AnnouncementDocument | null,
    document: null as AnnouncementDocument | null,
  });
  state.current.ready = ready;

  const changeMode = useCallback((next: Mode) => {
    state.current.articleGeneration++;
    state.current.mode = next;
    state.current.retryRequested = false;
    state.current.generation++;
    setMode(next);
  }, []);
  const showDocument = useCallback((next: AnnouncementDocument | null) => {
    state.current.document = next;
    setDocument(next);
  }, []);
  const close = useCallback(() => {
    const article = state.current.document;
    if (article && state.current.pendingClaim?.announcement.id === article.announcement.id)
      state.current.pendingClaim = null;
    changeMode('idle');
    showDocument(null);
    setLoading(false);
    setError(false);
    if (article) void client.dismiss(article.announcement.id).catch(() => undefined);
  }, [changeMode, client, showDocument]);

  const attempt = useCallback(
    async function runAttempt() {
      const current = state.current;
      const overlay = getOverlaySnapshot();
      if (
        !current.alive ||
        !current.ready ||
        document.readyState !== 'complete' ||
        current.mode !== 'idle' ||
        overlay.count ||
        !foreground()
      )
        return;
      if (current.pending) {
        current.retryRequested = true;
        return;
      }
      current.pending = true;
      const generation = current.generation;
      const valid = (): boolean =>
        current.alive &&
        current.ready &&
        current.mode === 'idle' &&
        current.generation === generation &&
        foreground() &&
        getOverlaySnapshot().generation === overlay.generation &&
        getOverlaySnapshot().count === 0;
      try {
        if (current.pendingClaim) {
          const article = current.pendingClaim;
          current.pendingClaim = null;
          if (Date.now() < Date.parse(article.announcement.validUntil)) {
            showDocument(article);
            changeMode('auto');
          }
          return;
        }
        const prepared = await client.prepareAuto();
        if (!prepared || !valid()) return;
        const article = await client.claimAuto({
          id: prepared.announcement.id,
          revision: prepared.revision,
          bodySha256: prepared.announcement.bodySha256,
        });
        if (!article) return;
        if (!valid()) {
          if (current.alive) current.pendingClaim = article;
          return;
        }
        showDocument(article);
        changeMode('auto');
      } catch {
        /* Auto failures are intentionally silent. */
      } finally {
        current.pending = false;
        if (current.retryRequested) {
          current.retryRequested = false;
          void runAttempt();
        }
      }
    },
    [changeMode, client, showDocument]
  );

  const receive = useCallback(
    (next: AnnouncementsSnapshot, allowAuto = true) => {
      if (!state.current.alive) return;
      const selection = `${next.status}:${next.revision}:${next.candidateId}:${next.checkedAt}`;
      const changed = selection !== lastSelection.current;
      lastSelection.current = selection;
      setSnapshot(next);
      const open = state.current.document;
      const claimed = state.current.pendingClaim;
      if (
        claimed &&
        next.checkedAt &&
        !next.items.some((item) => item.id === claimed.announcement.id)
      )
        state.current.pendingClaim = null;
      if (open && next.checkedAt && !next.items.some((item) => item.id === open.announcement.id)) {
        showDocument(null);
        if (state.current.mode === 'auto') changeMode('idle');
        else setError(true);
        return;
      }
      if (changed && allowAuto && state.current.manualRefreshes === 0) void attempt();
    },
    [attempt, changeMode, showDocument]
  );

  useEffect(() => {
    const current = state.current;
    current.alive = true;
    current.pending = false;
    void client
      .getSnapshot()
      .then(receive)
      .catch(() => {
        if (state.current.alive) setError(true);
      });
    const offState = client.onStateChanged(receive);
    const offHistory = subscribeAnnouncementHistory(() => {
      changeMode('history');
      showDocument(null);
      setError(false);
      setLoading(false);
      void client
        .getSnapshot()
        .then(receive)
        .catch(() => {
          if (state.current.alive) setError(true);
        });
    });
    let loadTimer: number | undefined;
    const onLoad = (): void => {
      // Yield past the load dispatch so main-frame loading has also completed before IPC.
      loadTimer = window.setTimeout(() => {
        state.current.generation++;
        void attempt();
      }, 0);
    };
    const onFocus = (): void => {
      state.current.generation++;
      void attempt();
    };
    const onBlur = (): void => {
      state.current.generation++;
      state.current.retryRequested = false;
    };
    const onVisibility = (): void => {
      state.current.generation++;
      if (foreground()) void attempt();
    };
    const offOverlay = subscribeOverlayOccupancy(() => {
      state.current.generation++;
      if (getOverlaySnapshot().count > 0) {
        if (state.current.mode !== 'idle') {
          if (state.current.mode === 'auto' && state.current.document)
            state.current.pendingClaim = state.current.document;
          changeMode('idle');
          showDocument(null);
        }
      } else void attempt();
    });
    window.addEventListener('load', onLoad);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      current.alive = false;
      current.generation++;
      current.articleGeneration++;
      current.pendingClaim = null;
      offState();
      offHistory();
      offOverlay();
      window.clearTimeout(loadTimer);
      window.removeEventListener('load', onLoad);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [attempt, changeMode, client, receive, showDocument]);
  useEffect(() => {
    if (ready) void attempt();
  }, [ready, attempt]);

  const openArticle = async (id: string): Promise<void> => {
    const generation = ++state.current.articleGeneration;
    setLoading(true);
    setError(false);
    try {
      const article = await client.openManual(id);
      if (
        !state.current.alive ||
        state.current.mode !== 'history' ||
        generation !== state.current.articleGeneration
      )
        return;
      if (article && state.current.pendingClaim?.announcement.id === article.announcement.id)
        state.current.pendingClaim = null;
      showDocument(article);
      setError(!article);
    } catch {
      if (state.current.alive && generation === state.current.articleGeneration) setError(true);
    } finally {
      if (state.current.alive && generation === state.current.articleGeneration) setLoading(false);
    }
  };
  const back = (): void => {
    const article = state.current.document;
    state.current.articleGeneration++;
    showDocument(null);
    setError(false);
    setLoading(false);
    if (article) void client.dismiss(article.announcement.id).catch(() => undefined);
  };
  const refresh = async (): Promise<void> => {
    state.current.manualRefreshes++;
    setLoading(true);
    setError(false);
    try {
      receive(await client.refresh(), false);
    } catch {
      if (state.current.alive) setError(true);
    } finally {
      state.current.manualRefreshes--;
      if (state.current.alive) setLoading(false);
    }
  };
  return {
    mode,
    article: documentState,
    snapshot,
    loading,
    error,
    close,
    openArticle,
    back,
    refresh,
  };
}
