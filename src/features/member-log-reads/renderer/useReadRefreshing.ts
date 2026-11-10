import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

interface RefreshOwner {
  readonly key: string;
  readonly leases: Set<object>;
  beganAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const MIN_VISIBLE_MS = 250;

export function useReadRefreshing(
  scopeKey: string,
  active: boolean
): {
  refreshing: boolean;
  beginRefreshing: () => () => void;
} {
  const ownerRef = useRef<RefreshOwner | null>(null);
  const desired = useRef({ scopeKey, active });
  useLayoutEffect(() => {
    desired.current = { scopeKey, active };
  });
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    const owner: RefreshOwner = { key: scopeKey, leases: new Set(), beganAt: null, timer: null };
    ownerRef.current = owner;
    setRefreshing(false);
    return () => {
      if (owner.timer !== null) clearTimeout(owner.timer);
      owner.leases.clear();
      if (ownerRef.current === owner) ownerRef.current = null;
    };
  }, [scopeKey, active]);

  const beginRefreshing = useCallback(() => {
    const owner = ownerRef.current;
    if (!owner || !desired.current.active || desired.current.scopeKey !== owner.key)
      return () => {};
    if (owner.timer !== null) clearTimeout(owner.timer);
    owner.timer = null;
    if (owner.leases.size === 0) owner.beganAt = Date.now();
    const lease = {};
    owner.leases.add(lease);
    setRefreshing(true);
    return () => {
      if (
        ownerRef.current !== owner ||
        desired.current.scopeKey !== owner.key ||
        !desired.current.active ||
        !owner.leases.delete(lease) ||
        owner.leases.size > 0
      )
        return;
      const delay = Math.max(0, MIN_VISIBLE_MS - (Date.now() - (owner.beganAt ?? Date.now())));
      owner.timer = setTimeout(() => {
        owner.timer = null;
        if (
          ownerRef.current === owner &&
          desired.current.scopeKey === owner.key &&
          desired.current.active &&
          owner.leases.size === 0
        )
          setRefreshing(false);
      }, delay);
    };
  }, []);
  return { refreshing: active && refreshing, beginRefreshing };
}
