/**
 * Hooks for accessing the TabUIContext.
 *
 * These hooks are in a separate file from the provider to support React Fast Refresh.
 */

import { useContext } from 'react';

import { TabUIContext } from './TabUIContext';

/**
 * Returns the current tab's ID, or null if not within a TabUIProvider.
 * Use this for components that may be rendered outside of a tab context.
 */
export function useTabIdOptional(): string | null {
  const context = useContext(TabUIContext);
  return context?.tabId ?? null;
}
