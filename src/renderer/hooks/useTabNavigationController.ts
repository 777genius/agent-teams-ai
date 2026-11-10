/**
 * Unified Tab Navigation Controller
 *
 * Single active-tab controller that replaces useNavigationCoordinator + useSearchContextNavigation.
 * Manages the complete lifecycle of navigation requests with proper sequencing:
 *
 * 1. Receive pending navigation request from tab state
 * 2. Ignore if tab is not active (prevents cross-tab races)
 * 3. Wait for content to load
 * 4. Expand target group and item
 * 5. Wait for DOM to stabilize
 * 6. Scroll to target
 * 7. Set highlight (red for error, yellow for search)
 * 8. Clear highlight after timeout
 * 9. Consume the navigation request (mark as processed)
 *
 * The nonce-based request model ensures:
 * - Repeated clicks create new navigations
 * - Tab switches don't re-trigger stale requests
 * - Auto-scroll is suppressed during navigation
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { isErrorPayload, isSearchPayload } from '@renderer/types/tabs';

import {
  calculateCenteredScrollTop,
  findAIGroupBySubagentId,
  findAIGroupByTimestamp,
  findChatItemByTimestamp,
  findCurrentSearchResultInContainer,
  waitForElementStability,
  waitForScrollEnd,
} from './navigation/utils';

import type { SessionConversation } from '@renderer/types/groups';
import type { TabNavigationRequest } from '@renderer/types/tabs';
import type { TriggerColor } from '@shared/constants/triggerColors';

// =============================================================================
// Types
// =============================================================================

export type NavigationPhase =
  | 'idle' // No navigation in progress
  | 'pending' // Navigation requested, waiting for content
  | 'expanding' // Expanding target group/item
  | 'scrolling' // Scrolling to target
  | 'highlighting' // Showing highlight ring
  | 'complete'; // Navigation done, waiting to clear highlight

interface UseTabNavigationControllerOptions {
  /** Whether this tab instance is currently the active tab */
  isActiveTab: boolean;
  /** Pending navigation request from tab state (undefined = no request) */
  pendingNavigation?: TabNavigationRequest;
  /** Conversation data (null while loading) */
  conversation: SessionConversation | null;
  /** Whether conversation is currently loading */
  conversationLoading: boolean;
  /** Function to consume (mark as processed) a navigation request */
  consumeTabNavigation: (tabId: string, requestId: string) => void;
  /** Tab ID for consuming navigation */
  tabId: string;
  /** Refs to AI group DOM elements */
  aiGroupRefs: React.RefObject<Map<string, HTMLElement>>;
  /** Refs to individual chat item DOM elements */
  chatItemRefs: React.RefObject<Map<string, HTMLElement>>;
  /** Refs to individual tool item DOM elements */
  toolItemRefs: React.RefObject<Map<string, HTMLElement>>;
  /** Function to expand an AI group (per-tab state) */
  expandAIGroup: (groupId: string) => void;
  /** Ref to scroll container */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Height of sticky elements at top of scroll container */
  stickyOffset?: number;
  /** Optional helper to ensure a target group is mounted (e.g., virtualized lists) */
  ensureGroupVisible?: (groupId: string) => Promise<void> | void;
  /** Function to expand a subagent trace (persists in per-tab state) */
  expandSubagentTrace: (subagentId: string) => void;
  /** Function to set search query in the search bar */
  setSearchQuery: (query: string) => void;
  /** Function to select an exact search match by item identity */
  selectSearchMatch: (itemId: string, matchIndexInItem: number) => boolean;
  /** Highlight duration in ms (default: 3000) */
  highlightDuration?: number;
}

interface UseTabNavigationControllerReturn {
  /** Current navigation phase */
  phase: NavigationPhase;
  /** Currently highlighted group ID */
  highlightedGroupId: string | null;
  /** Tool use ID to highlight */
  highlightToolUseId: string | null;
  /** Whether this is a search-based highlight (yellow) */
  isSearchHighlight: boolean;
  /** Custom highlight color from trigger (undefined = default red) */
  highlightColor: TriggerColor | undefined;
  /** Whether auto-scroll should be disabled */
  shouldDisableAutoScroll: boolean;
  /** Set highlighted group (for external control, e.g., turn navigation) */
  setHighlightedGroupId: (id: string | null) => void;
  /** Handle highlight end (clear highlight) */
  handleHighlightEnd: () => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useTabNavigationController(
  options: UseTabNavigationControllerOptions
): UseTabNavigationControllerReturn {
  const {
    isActiveTab,
    pendingNavigation,
    conversation,
    conversationLoading,
    consumeTabNavigation,
    tabId,
    aiGroupRefs,
    chatItemRefs,
    toolItemRefs,
    expandAIGroup,
    scrollContainerRef,
    stickyOffset = 0,
    ensureGroupVisible,
    expandSubagentTrace,
    setSearchQuery,
    selectSearchMatch,
    highlightDuration = 3000,
  } = options;

  // State
  const [phase, setPhase] = useState<NavigationPhase>('idle');
  const [highlightedGroupId, setHighlightedGroupId] = useState<string | null>(null);
  const [currentToolUseId, setCurrentToolUseId] = useState<string | null>(null);
  const [isSearchHighlight, setIsSearchHighlight] = useState(false);
  const [highlightColor, setHighlightColor] = useState<TriggerColor | undefined>(undefined);

  // Refs for tracking
  const activeRequestIdRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastFailureAtRef = useRef<number>(0);

  // Clear highlight and reset state
  const handleHighlightEnd = useCallback(() => {
    setHighlightedGroupId(null);
    setCurrentToolUseId(null);
    setIsSearchHighlight(false);
    setHighlightColor(undefined);
    setPhase('idle');
    activeRequestIdRef.current = null;

    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
  }, []);

  // Abort any in-progress navigation
  const abortNavigation = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
  }, []);

  // Execute error navigation sequence
  const executeErrorNavigation = useCallback(
    async (request: TabNavigationRequest, abortSignal: AbortSignal): Promise<boolean> => {
      if (!isErrorPayload(request) || !conversation) return false;
      const { errorTimestamp, toolUseId, subagentId } = request.payload;

      const checkAborted = (): boolean => abortSignal.aborted;

      // Find target AI group (subagent-aware lookup first, then timestamp fallback)
      let targetGroupId: string | null = null;
      if (subagentId) {
        targetGroupId = findAIGroupBySubagentId(conversation.items, subagentId);
      }
      if (!targetGroupId && errorTimestamp > 0) {
        targetGroupId = findAIGroupByTimestamp(conversation.items, errorTimestamp);
      }
      if (!targetGroupId) {
        // Fallback: last AI group
        const aiItems = conversation.items.filter((item) => item.type === 'ai');
        if (aiItems.length > 0) {
          targetGroupId = aiItems[aiItems.length - 1].group.id;
        }
      }
      if (!targetGroupId) return false;

      // Phase 1: Expanding
      setPhase('expanding');
      expandAIGroup(targetGroupId);
      // Persist subagent trace expansion so it survives highlight clearing
      if (subagentId) {
        expandSubagentTrace(subagentId);
      }
      await ensureGroupVisible?.(targetGroupId);
      if (checkAborted()) return false;

      // Set highlight early so it's visible even if scroll is imperfect
      setHighlightedGroupId(targetGroupId);
      setIsSearchHighlight(false);
      // Error navigation uses a TriggerColor (preset key or custom hex, defaulting to 'red')
      setHighlightColor(request.highlight === 'none' ? undefined : request.highlight);
      if (toolUseId) setCurrentToolUseId(toolUseId);

      // Wait for element to exist and stabilize
      let element: HTMLElement | undefined;
      const elementLookupStart = Date.now();
      while (Date.now() - elementLookupStart < 600) {
        element = aiGroupRefs.current.get(targetGroupId);
        if (element) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (checkAborted()) return false;
        await ensureGroupVisible?.(targetGroupId);
      }
      // If element not found, highlight is already set — return success
      if (!element) return true;
      await waitForElementStability(element, 250, 2);
      if (checkAborted()) return false;

      // Phase 2: Scrolling (best-effort — highlight already set)
      setPhase('scrolling');

      // Wait for tool item ref if needed (longer timeout for subagent cascading expansion)
      let toolElement: HTMLElement | undefined;
      if (toolUseId) {
        // Subagents need more time: AI group expand → display item expand → trace expand → tool render
        const toolLookupTimeout = subagentId ? 1200 : 300;
        const startTime = Date.now();
        while (Date.now() - startTime < toolLookupTimeout) {
          toolElement = toolItemRefs.current.get(toolUseId);
          if (toolElement) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (checkAborted()) return true; // Highlight already set
        }
        if (toolElement) {
          await waitForElementStability(toolElement, 300, 2);
          if (checkAborted()) return true; // Highlight already set
        }
      }

      // Scroll to target (best-effort)
      const targetElement = toolElement ?? element;
      const container = scrollContainerRef.current;
      if (targetElement && container) {
        const targetScrollTop = calculateCenteredScrollTop(targetElement, container, stickyOffset);
        container.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
        await waitForScrollEnd(container, 400);
      }
      if (checkAborted()) return false;

      // Phase 3: Highlight was set early, just update phase
      setPhase('highlighting');
      return true;
    },
    [
      conversation,
      expandAIGroup,
      expandSubagentTrace,
      aiGroupRefs,
      toolItemRefs,
      scrollContainerRef,
      stickyOffset,
      ensureGroupVisible,
    ]
  );

  // Execute search navigation sequence
  const executeSearchNavigation = useCallback(
    async (request: TabNavigationRequest, abortSignal: AbortSignal): Promise<boolean> => {
      if (!isSearchPayload(request) || !conversation) return false;
      const { query, messageTimestamp, targetGroupId, targetMatchIndexInItem } = request.payload;

      const checkAborted = (): boolean => abortSignal.aborted;

      // Find target chat item (prefer exact group ID when provided)
      const exactTargetItem =
        targetGroupId !== undefined
          ? conversation.items.find((item) => item.group.id === targetGroupId)
          : undefined;
      const targetItem =
        exactTargetItem &&
        (exactTargetItem.type === 'user' ||
          exactTargetItem.type === 'system' ||
          exactTargetItem.type === 'ai' ||
          exactTargetItem.type === 'compact')
          ? { groupId: exactTargetItem.group.id, type: exactTargetItem.type }
          : findChatItemByTimestamp(conversation.items, messageTimestamp);
      if (!targetItem) return false;

      // Phase 1: Expanding
      setPhase('expanding');
      setSearchQuery(query);
      if (targetGroupId !== undefined && targetMatchIndexInItem !== undefined) {
        selectSearchMatch(targetGroupId, targetMatchIndexInItem);
      }
      setHighlightedGroupId(targetItem.groupId);
      setIsSearchHighlight(true);
      await ensureGroupVisible?.(targetItem.groupId);
      if (checkAborted()) return false;

      // Wait for element to appear
      const startedAt = Date.now();
      let targetEl: Element | null = null;

      while (!checkAborted() && Date.now() - startedAt < 600) {
        targetEl = findCurrentSearchResultInContainer(
          scrollContainerRef.current,
          targetGroupId,
          targetMatchIndexInItem
        );
        if (!targetEl) {
          targetEl =
            chatItemRefs.current.get(targetItem.groupId) ??
            aiGroupRefs.current.get(targetItem.groupId) ??
            null;
        }
        if (targetEl) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
        await ensureGroupVisible?.(targetItem.groupId);
      }

      if (checkAborted()) return false;
      // If element not found, highlight is already set — return success
      if (!targetEl) return true;

      // Phase 2: Scrolling (best-effort — highlight already set)
      setPhase('scrolling');
      const container = scrollContainerRef.current;
      if (container && targetEl instanceof HTMLElement) {
        const targetScrollTop = calculateCenteredScrollTop(targetEl, container, stickyOffset);
        container.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
        await waitForScrollEnd(container, 400);
      } else if (targetEl instanceof HTMLElement) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise((resolve) => setTimeout(resolve, 350));
      }

      if (checkAborted()) return false;

      // Phase 3: Highlighting (yellow for search)
      setPhase('highlighting');
      // highlightedGroupId and isSearchHighlight already set above

      return true;
    },
    [
      conversation,
      scrollContainerRef,
      chatItemRefs,
      aiGroupRefs,
      stickyOffset,
      ensureGroupVisible,
      setSearchQuery,
      selectSearchMatch,
    ]
  );

  // Main navigation executor
  const executeNavigation = useCallback(
    async (request: TabNavigationRequest): Promise<void> => {
      abortNavigation();
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        let success = false;

        if (request.kind === 'error') {
          success = await executeErrorNavigation(request, abortController.signal);
        } else if (request.kind === 'search') {
          success = await executeSearchNavigation(request, abortController.signal);
        } else if (request.kind === 'autoBottom') {
          // autoBottom is handled by useAutoScrollBottom naturally
          // Just consume the request and stay idle
          consumeTabNavigation(tabId, request.id);
          return;
        }

        if (abortController.signal.aborted) return;

        if (success) {
          // Schedule highlight end
          highlightTimerRef.current = setTimeout(() => {
            if (!abortController.signal.aborted) {
              // Clear search state if it was a search navigation
              if (request.kind === 'search') {
                setSearchQuery('');
              }
              handleHighlightEnd();
            }
          }, highlightDuration);

          setPhase('complete');
        } else {
          // Navigation failed - reset
          setPhase('idle');
          setHighlightedGroupId(null);
          setCurrentToolUseId(null);
          setIsSearchHighlight(false);
          setHighlightColor(undefined);
          activeRequestIdRef.current = null;
          lastFailureAtRef.current = Date.now();
        }

        // Consume the request regardless of success/failure to prevent re-processing
        consumeTabNavigation(tabId, request.id);
      } catch {
        if (!abortController.signal.aborted) {
          setPhase('idle');
          activeRequestIdRef.current = null;
          lastFailureAtRef.current = Date.now();
          consumeTabNavigation(tabId, request.id);
        }
      }
    },
    [
      abortNavigation,
      executeErrorNavigation,
      executeSearchNavigation,
      consumeTabNavigation,
      tabId,
      highlightDuration,
      handleHighlightEnd,
      setSearchQuery,
    ]
  );

  // Effect: Detect and process new navigation requests
  useEffect(() => {
    // Ignore if not active tab (prevents cross-tab races)
    if (!isActiveTab) return;

    // No pending request
    if (!pendingNavigation) return;

    // Already processing this request
    if (activeRequestIdRef.current === pendingNavigation.id) return;

    // Recently failed - debounce
    if (Date.now() - lastFailureAtRef.current < 500) return;

    // Record this request
    activeRequestIdRef.current = pendingNavigation.id;

    // If content is loading, wait in pending state
    if (conversationLoading || !conversation) {
      queueMicrotask(() => setPhase('pending'));
      return;
    }

    // Execute navigation (deferred to avoid synchronous setState in effect)
    queueMicrotask(() => {
      void executeNavigation(pendingNavigation);
    });
  }, [isActiveTab, pendingNavigation, conversationLoading, conversation, executeNavigation]);

  // Effect: When content finishes loading and we're pending, start navigation
  useEffect(() => {
    if (phase !== 'pending') return;
    if (!isActiveTab) return;
    if (conversationLoading || !conversation) return;
    if (!pendingNavigation) return;

    queueMicrotask(() => {
      void executeNavigation(pendingNavigation);
    });
  }, [phase, isActiveTab, conversationLoading, conversation, pendingNavigation, executeNavigation]);

  // Effect: Reset when tab becomes inactive
  useEffect(() => {
    if (!isActiveTab && phase !== 'idle') {
      abortNavigation();
      queueMicrotask(() => {
        setPhase('idle');
        setHighlightedGroupId(null);
        setCurrentToolUseId(null);
        setIsSearchHighlight(false);
        setHighlightColor(undefined);
      });
      activeRequestIdRef.current = null;
    }
  }, [isActiveTab, phase, abortNavigation]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortNavigation();
    };
  }, [abortNavigation]);

  // Computed: should disable auto-scroll
  const shouldDisableAutoScroll =
    phase === 'pending' ||
    phase === 'expanding' ||
    phase === 'scrolling' ||
    phase === 'highlighting' ||
    phase === 'complete' ||
    // Also disable while any pendingNavigation exists (even before processing starts)
    (isActiveTab && pendingNavigation !== undefined);

  return {
    phase,
    highlightedGroupId,
    highlightToolUseId: currentToolUseId,
    isSearchHighlight,
    highlightColor,
    shouldDisableAutoScroll,
    setHighlightedGroupId,
    handleHighlightEnd,
  };
}
