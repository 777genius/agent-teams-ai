import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import {
  captureContextScopedRequestEpoch,
  subscribeContextScopedRequestEpoch,
} from '@renderer/store/utils/contextScopedRequestEpoch';

import type { MonitorError, RepositoryStatus } from '../../contracts';
import type { PullRequestSnapshot, PullRequestSummary } from '@pr-monitor/core';

interface ViewState {
  scope: string;
  repository: RepositoryStatus | null;
  items: readonly PullRequestSummary[];
  nextPage: number | null;
  snapshot: PullRequestSnapshot | null;
  error: MonitorError | null;
  loading: boolean;
  loadingDetail: boolean;
}
const initial = (scope: string): ViewState => ({
  scope,
  repository: null,
  items: [],
  nextPage: null,
  snapshot: null,
  error: null,
  loading: false,
  loadingDetail: false,
});
const safeError: MonitorError = {
  kind: 'offline',
  message: 'Could not load pull requests. Check your connection and try again.',
  retryAt: null,
};

export function nextPollDelay(error: MonitorError | null, failures: number, now: number): number {
  const retryAt = error?.retryAt ? Date.parse(error.retryAt) : 0;
  return Math.min(
    2_147_483_647,
    Math.max(30_000 * 2 ** Math.min(failures, 4), Number.isFinite(retryAt) ? retryAt - now : 0)
  );
}

export function useProjectPullRequests(projectId: string, active: boolean) {
  const contextId = useStore((state) => state.activeContextId);
  const epoch = useSyncExternalStore(
    subscribeContextScopedRequestEpoch,
    captureContextScopedRequestEpoch,
    captureContextScopedRequestEpoch
  );
  const scope = `${contextId}\0${projectId}\0${epoch}`;
  const [state, setState] = useState(() => initial(scope));
  const [selectedNumber, setSelectedNumber] = useState<number | undefined>();
  const control = useRef({
    scope,
    generation: 0,
    detail: 0,
    consentBusy: false,
    selected: undefined as number | undefined,
    error: null as MonitorError | null,
  });
  const refreshRef = useRef<() => void>(() => undefined);
  const current = state.scope === scope ? state : initial(scope);
  const request = { contextId, projectId };
  const invalidateAuthority = useCallback(
    (error: MonitorError): boolean => {
      if (error.kind !== 'sign_in_required' && error.kind !== 'consent_required') return false;
      const controller = control.current;
      if (controller.scope !== scope) return true;
      controller.generation++;
      controller.detail++;
      controller.selected = undefined;
      controller.error = { ...error, retryAt: null };
      setSelectedNumber(undefined);
      setState((value) => ({
        ...initial(scope),
        repository:
          value.scope === scope && value.repository
            ? { ...value.repository, connected: false, accountKind: undefined }
            : null,
        error: controller.error,
      }));
      return true;
    },
    [scope]
  );

  useEffect(() => {
    const controller =
      control.current.scope === scope
        ? control.current
        : {
            scope,
            generation: 0,
            detail: 0,
            consentBusy: false,
            selected: undefined as number | undefined,
            error: null as MonitorError | null,
          };
    if (control.current !== controller) {
      control.current = controller;
      setState(initial(scope));
      setSelectedNumber(undefined);
    }
    if (!active) return;
    let stopped = false;
    let busy = false;
    let refreshAgain = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const valid = () =>
      !stopped && control.current === controller && captureContextScopedRequestEpoch() === epoch;
    const update = (patch: Partial<ViewState>) => {
      if (valid())
        setState((value) => ({ ...(value.scope === scope ? value : initial(scope)), ...patch }));
    };
    async function refresh() {
      if (!valid() || document.hidden || controller.consentBusy) return;
      if (busy) {
        refreshAgain = true;
        return;
      }
      clearTimeout(timer);
      if (controller.error?.retryAt && Date.parse(controller.error.retryAt) > Date.now()) {
        timer = setTimeout(
          () => void refresh(),
          Math.min(2_147_483_647, Date.parse(controller.error.retryAt) - Date.now())
        );
        return;
      }
      busy = true;
      const generation = ++controller.generation;
      let ownedDetail = controller.detail;
      const currentRefresh = () => valid() && controller.generation === generation;
      const patch = (value: Partial<ViewState>) => {
        if (currentRefresh()) update(value);
      };
      patch({ loading: true });
      let error: MonitorError | null = null;
      try {
        const description = await api.prMonitor.describe({ contextId, projectId });
        if (!currentRefresh()) return;
        if (!description.ok) {
          error = description.error;
          invalidateAuthority(error);
          return;
        }
        patch({ repository: description.value });
        if (!description.value.connected) {
          patch({ items: [], nextPage: null, snapshot: null, loadingDetail: false });
          return;
        }
        const result = await api.prMonitor.list({ contextId, projectId });
        if (!currentRefresh()) return;
        if (!result.ok) {
          error = result.error;
          invalidateAuthority(error);
          return;
        }
        patch({ items: result.value.items, nextPage: result.value.nextPage });
        if (controller.selected !== undefined) {
          const detail = ++controller.detail;
          ownedDetail = detail;
          const snapshot = await api.prMonitor.get({
            contextId,
            projectId,
            number: controller.selected,
          });
          if (currentRefresh() && detail === controller.detail) {
            if (!snapshot.ok && invalidateAuthority(snapshot.error)) return;
            patch({ loadingDetail: false, ...(snapshot.ok ? { snapshot: snapshot.value } : {}) });
            if (!snapshot.ok) error = snapshot.error;
          }
        }
      } catch {
        error = safeError;
      } finally {
        busy = false;
        if (valid()) {
          if (currentRefresh()) {
            failures = error ? failures + 1 : 0;
            if (ownedDetail === controller.detail) controller.error = error;
            update({
              loading: false,
              ...(ownedDetail === controller.detail ? { error, loadingDetail: false } : {}),
            });
          }
          timer = setTimeout(
            () => void refresh(),
            refreshAgain ? 0 : nextPollDelay(controller.error, failures, Date.now())
          );
          refreshAgain = false;
        }
      }
    }
    refreshRef.current = () => {
      void refresh();
    };
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', visibility);
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
      refreshRef.current = () => undefined;
    };
  }, [active, contextId, epoch, invalidateAuthority, projectId, scope]);

  const select = useCallback(
    async (pullRequest: PullRequestSummary) => {
      const controller = control.current;
      if (
        controller.scope !== scope ||
        !active ||
        (controller.error?.retryAt && Date.parse(controller.error.retryAt) > Date.now())
      )
        return;
      controller.selected = pullRequest.number;
      const detail = ++controller.detail;
      setSelectedNumber(pullRequest.number);
      setState((value) => ({ ...value, snapshot: null, loadingDetail: true, error: null }));
      try {
        const result = await api.prMonitor.get({
          contextId,
          projectId,
          number: pullRequest.number,
        });
        if (
          control.current !== controller ||
          detail !== controller.detail ||
          captureContextScopedRequestEpoch() !== epoch
        )
          return;
        if (!result.ok && invalidateAuthority(result.error)) return;
        controller.error = result.ok ? null : result.error;
        setState((value) => ({
          ...value,
          loadingDetail: false,
          snapshot: result.ok ? result.value : null,
          error: controller.error,
        }));
      } catch {
        if (control.current === controller && detail === controller.detail)
          setState((value) => ({ ...value, loadingDetail: false, error: safeError }));
      }
    },
    [active, contextId, epoch, invalidateAuthority, projectId, scope]
  );

  async function consent(enabled: boolean) {
    const controller = control.current;
    if (controller.scope !== scope || controller.consentBusy) return;
    controller.consentBusy = true;
    controller.generation++;
    controller.detail++;
    setState((value) => ({ ...value, loading: true, loadingDetail: false }));
    try {
      const result = await api.prMonitor[enabled ? 'connect' : 'disconnect'](request);
      if (control.current !== controller || captureContextScopedRequestEpoch() !== epoch) return;
      controller.consentBusy = false;
      setState((value) => ({
        ...value,
        loading: false,
        repository: result.ok ? result.value : value.repository,
        items: [],
        nextPage: null,
        snapshot: null,
        error: result.ok ? null : result.error,
      }));
      controller.selected = undefined;
      controller.detail++;
      controller.error = result.ok ? null : result.error;
      setSelectedNumber(undefined);
      if (result.ok && enabled) refreshRef.current();
    } catch {
      controller.consentBusy = false;
      if (control.current === controller && captureContextScopedRequestEpoch() === epoch)
        setState((value) => ({ ...value, loading: false, error: safeError }));
    }
  }

  async function loadMore() {
    if (
      !active ||
      !current.nextPage ||
      current.loading ||
      (control.current.error?.retryAt && Date.parse(control.current.error.retryAt) > Date.now())
    )
      return;
    const controller = control.current;
    const generation = controller.generation;
    setState((value) => ({ ...value, loading: true }));
    try {
      const result = await api.prMonitor.list({ ...request, page: current.nextPage });
      if (
        control.current !== controller ||
        generation !== controller.generation ||
        captureContextScopedRequestEpoch() !== epoch
      )
        return;
      if (!result.ok && invalidateAuthority(result.error)) return;
      controller.error = result.ok ? null : result.error;
      setState((value) => ({
        ...value,
        loading: false,
        error: result.ok ? null : result.error,
        ...(result.ok
          ? {
              nextPage: result.value.nextPage,
              items: [
                ...new Map(
                  [...value.items, ...result.value.items].map((item) => [item.number, item])
                ).values(),
              ],
            }
          : {}),
      }));
    } catch {
      if (control.current === controller)
        setState((value) => ({ ...value, loading: false, error: safeError }));
    }
  }

  return {
    ...current,
    selectedNumber: state.scope === scope ? selectedNumber : undefined,
    select,
    loadMore,
    connect: () => consent(true),
    disconnect: () => consent(false),
    refresh: () => refreshRef.current(),
    connectionChanged: () => {
      const controller = control.current;
      if (controller.scope !== scope) return;
      controller.generation++;
      controller.detail++;
      controller.error = null;
      controller.selected = undefined;
      setSelectedNumber(undefined);
      setState(initial(scope));
      refreshRef.current();
    },
  };
}
