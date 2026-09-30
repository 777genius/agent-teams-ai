import { useEffect, useRef, useState } from 'react';

import type { RefObject } from 'react';

/** Query lifetime is the mounted Dashboard, independent of either read source. */
export function useDashboardInteraction(scopeKey: string): {
  query: string;
  setQuery: (query: string) => void;
  clear: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
} {
  const [search, setSearch] = useState({ scopeKey, query: '' });
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setSearch((previous) => (previous.scopeKey === scopeKey ? previous : { scopeKey, query: '' }));
  }, [scopeKey]);

  return {
    // Never show an old scope's query during the first render of a new scope.
    query: search.scopeKey === scopeKey ? search.query : '',
    setQuery: (query) => setSearch({ scopeKey, query }),
    clear: () => {
      setSearch({ scopeKey, query: '' });
      searchRef.current?.focus({ preventScroll: true });
    },
    searchRef,
  };
}
