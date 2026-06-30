/**
 * Notification slice - manages notifications state and actions.
 */

import { api } from '@renderer/api';
import { createErrorNavigationRequest, findTabBySessionAndProject } from '@renderer/types/tabs';
import { createLogger } from '@shared/utils/logger';

import { getAllTabs } from '../utils/paneHelpers';

import type { AppState } from '../types';
import type { DetectedError } from '@renderer/types/data';
import type { NotificationTarget } from '@shared/types';
import type { StateCreator } from 'zustand';

const logger = createLogger('Store:notification');
const NOTIFICATIONS_FETCH_LIMIT = 200;

function getTeamNameFromError(error: DetectedError): string | null {
  if (error.sessionId.startsWith('team:')) {
    const teamName = error.sessionId.slice('team:'.length).trim();
    return teamName || null;
  }
  return null;
}

function isNotificationTarget(value: unknown): value is NotificationTarget {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (row.kind === 'team') return typeof row.teamName === 'string' && row.teamName.length > 0;
  if (row.kind === 'token_usage') {
    return (
      row.focus === undefined ||
      row.focus === 'overview' ||
      row.focus === 'budgets' ||
      row.focus === 'notifications'
    );
  }
  if (row.kind === 'task') {
    return (
      typeof row.teamName === 'string' &&
      row.teamName.length > 0 &&
      typeof row.taskId === 'string' &&
      row.taskId.length > 0
    );
  }
  if (row.kind === 'member') {
    return (
      typeof row.teamName === 'string' &&
      row.teamName.length > 0 &&
      typeof row.memberName === 'string' &&
      row.memberName.length > 0
    );
  }
  return false;
}

function parseLegacyTeamTarget(error: DetectedError, fallbackTeamName: string): NotificationTarget {
  const dedupeParts = (error.dedupeKey ?? '').split(':');
  const kind = dedupeParts[0];
  const teamName = dedupeParts[1] || fallbackTeamName;

  if (
    (kind === 'comment' || kind === 'clarification' || kind === 'status' || kind === 'created') &&
    dedupeParts[2]
  ) {
    return {
      kind: 'task',
      teamName,
      taskId: dedupeParts[2],
      commentId: kind === 'comment' ? dedupeParts[3] : undefined,
      focus: kind === 'comment' || kind === 'clarification' ? 'comments' : 'detail',
    };
  }

  if (kind === 'inbox' && dedupeParts[2]) {
    return { kind: 'member', teamName, memberName: dedupeParts[2], focus: 'messages' };
  }

  return { kind: 'team', teamName, section: 'overview' };
}

function getTeamNotificationTarget(error: DetectedError): NotificationTarget | null {
  if (isNotificationTarget(error.target)) {
    return error.target;
  }

  const teamName = getTeamNameFromError(error);
  if (!teamName) return null;

  return parseLegacyTeamTarget(error, teamName);
}

function navigateToTeamNotification(state: AppState, error: DetectedError): void {
  const target = getTeamNotificationTarget(error);
  if (target?.kind === 'token_usage') {
    state.openTab({ type: 'token-usage', label: 'Usage' });
    return;
  }

  const teamName = target?.teamName ?? getTeamNameFromError(error);
  if (!teamName) return;

  state.openTeamTab(teamName, error.context.cwd);

  if (target?.kind === 'team' && target.section) {
    state.focusTeamSection(target.teamName, target.section);
  } else if (target?.kind === 'task') {
    state.openGlobalTaskDetail(target.teamName, target.taskId, target.commentId);
  } else if (target?.kind === 'member') {
    state.openMemberProfile(target.memberName, target.teamName, target.focus);
  }
}

// =============================================================================
// Slice Interface
// =============================================================================

export interface NotificationSlice {
  // State
  notifications: DetectedError[];
  unreadCount: number;
  notificationsLoading: boolean;
  notificationsError: string | null;

  // Actions
  fetchNotifications: () => Promise<void>;
  markNotificationRead: (id: string) => Promise<void>;
  markAllNotificationsRead: (triggerName?: string) => Promise<void>;
  deleteNotification: (id: string) => Promise<void>;
  clearNotifications: (triggerName?: string) => Promise<void>;
  navigateToError: (error: DetectedError) => void;
  openNotificationsTab: () => void;
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createNotificationSlice: StateCreator<AppState, [], [], NotificationSlice> = (
  set,
  get
) => ({
  // Initial state
  notifications: [],
  unreadCount: 0,
  notificationsLoading: false,
  notificationsError: null,

  // Fetch all notifications from main process
  fetchNotifications: async () => {
    set({ notificationsLoading: true, notificationsError: null });
    try {
      // Fetch the full stored history (manager currently caps storage at 100).
      const result = await api.notifications.get({
        limit: NOTIFICATIONS_FETCH_LIMIT,
        offset: 0,
      });
      const notifications = result.notifications || [];
      const unreadCount =
        typeof result.unreadCount === 'number' && Number.isFinite(result.unreadCount)
          ? Math.max(0, Math.floor(result.unreadCount))
          : notifications.filter((n: { isRead: boolean }) => !n.isRead).length;
      set({
        notifications,
        unreadCount,
        notificationsLoading: false,
      });
    } catch (error) {
      set({
        notificationsError:
          error instanceof Error ? error.message : 'Failed to fetch notifications',
        notificationsLoading: false,
      });
    }
  },

  // Mark a single notification as read
  markNotificationRead: async (id: string) => {
    try {
      const success = await api.notifications.markRead(id);
      if (!success) {
        await get().fetchNotifications();
        return;
      }
      // Optimistically update local state
      set((state) => {
        const notifications = state.notifications.map((n) =>
          n.id === id ? { ...n, isRead: true } : n
        );
        const unreadCount = notifications.filter((n) => !n.isRead).length;
        return { notifications, unreadCount };
      });
    } catch (error) {
      logger.error('Failed to mark notification as read:', error);
    }
  },

  // Mark all notifications as read (optionally scoped to a trigger)
  markAllNotificationsRead: async (triggerName?: string) => {
    try {
      if (triggerName !== undefined) {
        // Scoped: mark only matching unread notifications
        const { notifications } = get();
        const matching = notifications.filter((n) => {
          const label = n.triggerName ?? 'Other';
          return label === triggerName && !n.isRead;
        });
        if (matching.length === 0) return;
        const results = await Promise.all(matching.map((n) => api.notifications.markRead(n.id)));
        if (results.some((r) => !r)) {
          await get().fetchNotifications();
          return;
        }
        const matchingIds = new Set(matching.map((n) => n.id));
        set((state) => {
          const updated = state.notifications.map((n) =>
            matchingIds.has(n.id) ? { ...n, isRead: true } : n
          );
          return { notifications: updated, unreadCount: updated.filter((n) => !n.isRead).length };
        });
      } else {
        // Unscoped: mark all
        const success = await api.notifications.markAllRead();
        if (!success) {
          await get().fetchNotifications();
          return;
        }
        set((state) => ({
          notifications: state.notifications.map((n) => ({ ...n, isRead: true })),
          unreadCount: 0,
        }));
      }
    } catch (error) {
      logger.error('Failed to mark all notifications as read:', error);
    }
  },

  // Delete a single notification
  deleteNotification: async (id: string) => {
    try {
      const success = await api.notifications.delete(id);
      if (!success) {
        await get().fetchNotifications();
        return;
      }
      // Optimistically update local state
      set((state) => {
        const notifications = state.notifications.filter((n) => n.id !== id);
        const unreadCount = notifications.filter((n) => !n.isRead).length;
        return { notifications, unreadCount };
      });
    } catch (error) {
      logger.error('Failed to delete notification:', error);
    }
  },

  // Clear all notifications (optionally scoped to a trigger)
  clearNotifications: async (triggerName?: string) => {
    try {
      if (triggerName !== undefined) {
        // Scoped: delete only matching notifications
        const { notifications } = get();
        const matching = notifications.filter((n) => {
          const label = n.triggerName ?? 'Other';
          return label === triggerName;
        });
        if (matching.length === 0) return;
        const results = await Promise.all(matching.map((n) => api.notifications.delete(n.id)));
        if (results.some((r) => !r)) {
          await get().fetchNotifications();
          return;
        }
        const matchingIds = new Set(matching.map((n) => n.id));
        set((state) => {
          const remaining = state.notifications.filter((n) => !matchingIds.has(n.id));
          return {
            notifications: remaining,
            unreadCount: remaining.filter((n) => !n.isRead).length,
          };
        });
      } else {
        // Unscoped: clear all
        const success = await api.notifications.clear();
        if (!success) {
          await get().fetchNotifications();
          return;
        }
        set({
          notifications: [],
          unreadCount: 0,
        });
      }
    } catch (error) {
      logger.error('Failed to clear notifications:', error);
    }
  },

  // Navigate to error location in session (deep linking)
  navigateToError: (error: DetectedError) => {
    const state = get();

    // Mark the notification as read
    void state.markNotificationRead(error.id);

    // Team notifications use structured targets when available.
    if (error.sessionId.startsWith('team:')) {
      navigateToTeamNotification(state, error);
      return;
    }

    // Create the navigation request with a fresh nonce
    const navRequest = createErrorNavigationRequest(
      {
        errorId: error.id,
        errorTimestamp: error.timestamp,
        toolUseId: error.toolUseId,
        subagentId: error.subagentId,
        lineNumber: error.lineNumber,
      },
      'notification',
      error.triggerColor
    );

    // Check if session tab is already open across all panes
    const allTabs = getAllTabs(state.paneLayout);
    const existingTab = findTabBySessionAndProject(allTabs, error.sessionId, error.projectId);

    if (existingTab) {
      // Focus existing tab via setActiveTab for proper sidebar sync
      state.setActiveTab(existingTab.id);
      // Enqueue navigation request with fresh nonce
      state.enqueueTabNavigation(existingTab.id, navRequest);
    } else {
      // Open new session tab via openTab (properly adds to focused pane)
      state.openTab({
        type: 'session',
        label: 'Loading...',
        projectId: error.projectId,
        sessionId: error.sessionId,
      });

      // Enqueue navigation on the newly created tab, then trigger sidebar
      // sync + session data fetch via setActiveTab
      const newTabId = get().activeTabId;
      if (newTabId) {
        state.enqueueTabNavigation(newTabId, navRequest);
        get().setActiveTab(newTabId);
      }
    }
  },

  // Open or focus the notifications tab (per-pane singleton)
  openNotificationsTab: () => {
    const state = get();

    // Check if notifications tab exists in focused pane
    const focusedPane = state.paneLayout.panes.find((p) => p.id === state.paneLayout.focusedPaneId);
    const notificationsTab = focusedPane?.tabs.find((t) => t.type === 'notifications');
    if (notificationsTab) {
      state.setActiveTab(notificationsTab.id);
      // Re-sync in case updates happened while tab was inactive.
      void state.fetchNotifications();
      return;
    }

    // Create new notifications tab via openTab (which adds to focused pane)
    state.openTab({
      type: 'notifications',
      label: 'Notifications',
    });
  },
});
