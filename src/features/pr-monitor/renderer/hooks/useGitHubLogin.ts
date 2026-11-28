import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import {
  captureContextScopedRequestEpoch,
  subscribeContextScopedRequestEpoch,
} from '@renderer/store/utils/contextScopedRequestEpoch';

import type { DeviceLogin, MonitorError } from '../../contracts';

export function useGitHubLogin(projectId: string, active: boolean, onConnected: () => void) {
  const contextId = useStore((state) => state.activeContextId);
  const epoch = useSyncExternalStore(
    subscribeContextScopedRequestEpoch,
    captureContextScopedRequestEpoch,
    captureContextScopedRequestEpoch
  );
  const scope = `${contextId}\0${projectId}\0${epoch}`;
  const [state, setState] = useState<{
    scope: string;
    login: DeviceLogin | null;
    error: MonitorError | null;
    busy: boolean;
  }>({ scope, login: null, error: null, busy: false });
  const current = useRef(scope);
  const refresh = useRef(onConnected);
  useEffect(() => {
    refresh.current = onConnected;
  }, [onConnected]);
  useEffect(() => {
    current.current = scope;
    setState({ scope, login: null, error: null, busy: false });
  }, [scope]);
  const login = state.scope === scope ? state.login : null;
  useEffect(() => {
    if (!login) return;
    if (!active) {
      setState({ scope, login: null, error: null, busy: false });
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api.prMonitor.pollLogin({
          contextId,
          projectId,
          attemptId: login!.attemptId,
        });
        if (stopped || current.current !== scope || captureContextScopedRequestEpoch() !== epoch)
          return;
        if (!result.ok) {
          setState({ scope, login: null, error: result.error, busy: false });
          return;
        }
        if (result.value.status === 'connected') {
          setState({ scope, login: null, error: null, busy: false });
          refresh.current();
          return;
        }
        timer = setTimeout(
          () => void poll(),
          Math.min(2_147_483_647, Math.max(1000, Date.parse(result.value.retryAt) - Date.now()))
        );
      } catch {
        if (!stopped)
          setState({
            scope,
            login: null,
            error: {
              kind: 'offline',
              message: 'GitHub sign-in could not finish. Try again.',
              retryAt: null,
            },
            busy: false,
          });
      }
    }
    timer = setTimeout(
      () => void poll(),
      Math.min(
        2_147_483_647,
        login.intervalMs,
        Math.max(1000, Date.parse(login.expiresAt) - Date.now())
      )
    );
    return () => {
      stopped = true;
      clearTimeout(timer);
      void api.prMonitor
        .cancelLogin({ contextId, projectId, attemptId: login.attemptId })
        .catch(() => undefined);
    };
  }, [active, contextId, epoch, login, projectId, scope]);

  async function begin() {
    if (state.busy || login) return;
    setState({ scope, login: null, error: null, busy: true });
    try {
      const result = await api.prMonitor.beginLogin({ contextId, projectId });
      if (current.current !== scope || captureContextScopedRequestEpoch() !== epoch) {
        if (result.ok)
          void api.prMonitor
            .cancelLogin({ contextId, projectId, attemptId: result.value.attemptId })
            .catch(() => undefined);
        return;
      }
      setState({
        scope,
        login: result.ok ? result.value : null,
        error: result.ok ? null : result.error,
        busy: false,
      });
    } catch {
      if (current.current === scope)
        setState({
          scope,
          login: null,
          error: {
            kind: 'offline',
            message: 'Could not start GitHub sign-in. Try again.',
            retryAt: null,
          },
          busy: false,
        });
    }
  }
  async function signOut() {
    setState({ scope, login: null, error: null, busy: true });
    try {
      const result = await api.prMonitor.signOut({ contextId, projectId });
      if (current.current !== scope) return;
      setState({ scope, login: null, error: result.ok ? null : result.error, busy: false });
      refresh.current();
    } catch {
      if (current.current === scope) {
        setState({
          scope,
          login: null,
          error: { kind: 'unknown', message: 'Could not sign out. Try again.', retryAt: null },
          busy: false,
        });
        refresh.current();
      }
    }
  }
  return {
    login,
    error: state.scope === scope ? state.error : null,
    busy: state.busy,
    begin,
    signOut,
    cancel: () => setState({ scope, login: null, error: null, busy: false }),
  };
}
