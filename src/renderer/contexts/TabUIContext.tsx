/**
 * TabUIContext - Provides the current tab's ID to all descendant components.
 *
 * This context enables per-tab UI state isolation. Components use the tabId
 * from this context to access their tab-specific state from the store.
 *
 * Usage:
 * ```tsx
 * // In TabbedLayout (provider):
 * <TabUIProvider tabId={tab.id}>
 *   <SessionTabContent />
 * </TabUIProvider>
 *
 * // In any descendant component (consumer):
 * const tabId = useTabId();
 * const { expandedIds, toggleExpansion } = useTabUI();
 * ```
 */

import { createContext, type JSX, type ReactNode } from 'react';

// =============================================================================
// Context Definition
// =============================================================================

interface TabUIContextValue {
  /** The unique ID of the current tab */
  tabId: string;
}

const TabUIContext = createContext<TabUIContextValue | null>(null);

export { TabUIContext };

// =============================================================================
// Provider Component
// =============================================================================

interface TabUIProviderProps {
  /** The tab ID to provide to descendants */
  tabId: string;
  children: ReactNode;
}

/**
 * Provides the tab ID to all descendant components.
 * Wrap each tab's content with this provider.
 */
export const TabUIProvider = ({ tabId, children }: TabUIProviderProps): JSX.Element => {
  return <TabUIContext.Provider value={{ tabId }}>{children}</TabUIContext.Provider>;
};
