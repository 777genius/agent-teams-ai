import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type {
  DetailReadCoordinator,
  DetailReadSubscription,
  DetailReadWork,
} from '../core/application/DetailReadCoordinator';
import type { MemberLogReadScope } from './memberLogReadScope';

interface Options<T> {
  readonly coordinator: DetailReadCoordinator<T>;
  readonly scope: MemberLogReadScope;
  readonly key: string | null;
  /** Completed presentation may survive a policy change within the same view owner. */
  readonly presentationKey?: string;
  readonly active: boolean;
  readonly poll: boolean;
  readonly initialFresh?: boolean;
  readonly showBackgroundErrors?: boolean;
  readonly read: (fresh: boolean) => Promise<T | null>;
  readonly beginRefreshing: () => () => void;
}

interface ReadState<T> {
  key: string | null;
  presentationKey: string | null;
  value: T | null;
  loading: boolean;
  error: unknown;
  settledAt: number | null;
}

interface Owner<T> {
  alive: boolean;
  running: boolean;
  lastSettled: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  subscription: DetailReadSubscription<T> | null;
  schedule(): void;
}

const POLL_DELAY_MS = 5000;

interface ReadResult<T> {
  value: T | null;
  error: unknown;
  loading: boolean;
  settledAt: number | null;
}

function prepareRead<T>(
  scope: MemberLogReadScope,
  read: Options<T>['read'],
  fresh: boolean
): DetailReadWork<T> {
  return { isCurrent: () => scope.isCurrent(), execute: () => read(fresh), release() {} };
}

/** A mounted subscription, with automatic reads scheduled only after settlement. */
export function useCompletionRead<T>(options: Options<T>): ReadResult<T> {
  const { coordinator, scope, key, active, poll } = options;
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const ownerRef = useRef<Owner<T> | null>(null);
  const [state, setState] = useState<ReadState<T>>({
    key: null,
    presentationKey: null,
    value: null,
    loading: false,
    error: null,
    settledAt: null,
  });
  // Scope is part of the publication address even when retrieval IDs are unchanged.
  const address = key === null ? null : JSON.stringify([scope.key, key]);
  const presentationKey =
    key === null ? null : JSON.stringify([scope.key, options.presentationKey ?? key]);

  useEffect(() => {
    if (key === null) {
      setState((previous) =>
        previous.key === null
          ? previous
          : {
              key: null,
              presentationKey: null,
              value: null,
              loading: false,
              error: null,
              settledAt: null,
            }
      );
      return;
    }
    if (!active) return;
    const owner: Owner<T> = {
      alive: true,
      running: false,
      lastSettled: null,
      timer: null,
      subscription: null,
      schedule: () => undefined,
    };
    ownerRef.current = owner;
    const current = (): boolean =>
      owner.alive &&
      ownerRef.current === owner &&
      latest.current.active &&
      latest.current.key === key &&
      latest.current.scope.key === scope.key &&
      scope.isCurrent();
    const clearTimer = (): void => {
      if (owner.timer !== null) clearTimeout(owner.timer);
      owner.timer = null;
    };
    const run = async (fresh: boolean, background: boolean): Promise<void> => {
      if (!current() || owner.running) return;
      clearTimer();
      owner.running = true;
      const hasCompletedPresentation =
        state.presentationKey === presentationKey && state.value !== null;
      const finishRefreshing =
        background || hasCompletedPresentation ? latest.current.beginRefreshing() : () => undefined;
      const read = latest.current.read;
      if (background && latest.current.showBackgroundErrors) {
        setState((previous) => ({ ...previous, error: null }));
      }
      if (!background)
        setState((previous) => ({
          key: address,
          presentationKey,
          value: previous.presentationKey === presentationKey ? previous.value : null,
          loading: true,
          error: null,
          settledAt: previous.presentationKey === presentationKey ? previous.settledAt : null,
        }));
      const subscription = coordinator.subscribe({
        key: address!,
        source: scope.source,
        owner,
        fresh,
        prepare: () => prepareRead(scope, read, fresh),
      });
      owner.subscription = subscription;
      try {
        const outcome = await subscription.result;
        if (!current()) return;
        if (outcome.status === 'success') {
          setState({
            key: address,
            presentationKey,
            value: outcome.value,
            loading: false,
            error: null,
            settledAt: Date.now(),
          });
        } else if (
          outcome.status === 'failure' &&
          (!background || latest.current.showBackgroundErrors)
        ) {
          setState((previous) => ({
            key: address,
            presentationKey,
            value:
              latest.current.showBackgroundErrors && previous.presentationKey === presentationKey
                ? previous.value
                : null,
            loading: false,
            error: outcome.error,
            settledAt: Date.now(),
          }));
        }
      } finally {
        subscription.dispose();
        finishRefreshing();
        if (current()) {
          owner.running = false;
          owner.subscription = null;
          owner.lastSettled = Date.now();
          setState((previous) =>
            previous.key === address
              ? { ...previous, loading: false, settledAt: owner.lastSettled }
              : previous
          );
          owner.schedule();
        }
      }
    };
    owner.schedule = () => {
      clearTimer();
      if (!current() || owner.running || !latest.current.poll || owner.lastSettled === null) return;
      const delay = Math.max(0, owner.lastSettled + POLL_DELAY_MS - Date.now());
      owner.timer = setTimeout(() => {
        owner.timer = null;
        if (current() && latest.current.poll) void run(true, true);
      }, delay);
    };
    void run(latest.current.initialFresh ?? false, false);
    return () => {
      owner.alive = false;
      clearTimer();
      owner.subscription?.dispose();
      owner.subscription = null;
      if (ownerRef.current === owner) ownerRef.current = null;
    };
    // The source identity is stable; poll policy and presentation updates do not restart reads.
  }, [active, address, coordinator, scope.source]);

  useEffect(() => {
    ownerRef.current?.schedule();
  }, [poll]);

  return {
    value: state.presentationKey === presentationKey ? state.value : null,
    error: state.key === address ? state.error : null,
    loading: active && key !== null && (state.key !== address || state.loading),
    settledAt: state.presentationKey === presentationKey ? state.settledAt : null,
  };
}
