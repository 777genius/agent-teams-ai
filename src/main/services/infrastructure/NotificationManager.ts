/**
 * NotificationManager service - Manages native notifications and notification history.
 *
 * Responsibilities:
 * - Store notification history at ~/.claude/agent-teams-notifications.json (max 100 entries)
 * - Show native notifications using Electron's Notification API (cross-platform)
 * - Two adapters: addError() for error notifications, addTeamNotification() for team events
 * - Shared internal pipeline: storeNotification() for unconditional storage + IPC emission
 * - Two-level dedup: dedupeKey for storage dedup, toast throttle (5s) for native toasts
 * - Storage is unconditional — enabled/snoozed only affect native OS toasts
 * - Respect config.notifications.enabled and snoozedUntil for toasts
 * - Filter errors matching ignoredRegex patterns (error-specific)
 * - Filter errors from ignoredProjects (error-specific)
 * - Auto-prune notifications over 100 on startup
 * - Emit IPC events to renderer: notification:new, notification:updated
 */

import { getAppIconPath } from '@main/utils/appIcon';
import { getHomeDir } from '@main/utils/pathDecoder';
import { safeSendToRenderer } from '@main/utils/safeWebContentsSend';
import { stripMarkdown } from '@main/utils/textFormatting';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { createLogger } from '@shared/utils/logger';
import { Notification as ElectronNotification } from 'electron';
import { EventEmitter } from 'events';
import * as fsp from 'fs/promises';
import * as path from 'path';

import { type DetectedError } from '../error/ErrorMessageBuilder';

import type { BrowserWindow, NotificationConstructorOptions } from 'electron';

const logger = createLogger('Service:NotificationManager');
import {
  buildDetectedErrorFromTeam,
  type TeamNotificationPayload,
} from '@main/utils/teamNotificationBuilder';

import { projectPathResolver } from '../discovery/ProjectPathResolver';
import { gitIdentityResolver } from '../parsing/GitIdentityResolver';

import { ConfigManager } from './ConfigManager';

// Re-export DetectedError for backward compatibility
export type { DetectedError };
// Re-export team notification types for callers
export type { TeamEventType, TeamNotificationPayload } from '@main/utils/teamNotificationBuilder';

/**
 * Stored notification with read status.
 */
export interface StoredNotification extends DetectedError {
  /** Whether the notification has been read */
  isRead: boolean;
  /** When the notification was created (may differ from error timestamp) */
  createdAt: number;
}

/**
 * Pagination options for getNotifications.
 */
export interface GetNotificationsOptions {
  /** Number of notifications to return */
  limit?: number;
  /** Number of notifications to skip */
  offset?: number;
}

/**
 * Result of getNotifications call.
 */
export interface GetNotificationsResult {
  /** Notifications for this page */
  notifications: StoredNotification[];
  /** Total number of notifications */
  total: number;
  /** Total count (alias for IPC compatibility) */
  totalCount: number;
  /** Number of unread notifications */
  unreadCount: number;
  /** Whether there are more notifications to load */
  hasMore: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** Maximum number of notifications to store */
const MAX_NOTIFICATIONS = 100;

/** Throttle window in milliseconds (5 seconds) */
const THROTTLE_MS = 5000;

/** Path to notifications storage file */
const NOTIFICATIONS_PATH = path.join(getHomeDir(), '.claude', 'agent-teams-notifications.json');
const LEGACY_NOTIFICATION_FILENAMES = [
  'claude-devtools-notifications.json',
  'claude-code-context-notifications.json',
] as const;
const LEGACY_NOTIFICATION_PATHS = LEGACY_NOTIFICATION_FILENAMES.map((filename) =>
  path.join(getHomeDir(), '.claude', filename)
);

interface LegacyNotificationData {
  path: string;
  data: string;
}

type NotificationEventName = 'click' | 'close' | 'show' | 'failed';

interface NotificationInstance {
  on(event: NotificationEventName, listener: (...args: unknown[]) => void): void;
  show(): void;
}

interface NotificationClass {
  new (options: NotificationConstructorOptions): NotificationInstance;
  isSupported(): boolean;
}

function getNotificationClass(): NotificationClass | null {
  return (ElectronNotification as NotificationClass | undefined) ?? null;
}

async function migrateLegacyNotificationPath(): Promise<string> {
  try {
    await fsp.readFile(NOTIFICATIONS_PATH, 'utf8');
    return NOTIFICATIONS_PATH;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return NOTIFICATIONS_PATH;
    }
  }

  const legacyNotificationData = await selectLegacyNotificationData();
  if (!legacyNotificationData) {
    return NOTIFICATIONS_PATH;
  }

  try {
    await fsp.mkdir(path.dirname(NOTIFICATIONS_PATH), { recursive: true });
    await fsp.writeFile(NOTIFICATIONS_PATH, legacyNotificationData.data, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return NOTIFICATIONS_PATH;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return NOTIFICATIONS_PATH;
    }

    return legacyNotificationData.path;
  }
}

async function selectLegacyNotificationData(): Promise<LegacyNotificationData | null> {
  const readableData: LegacyNotificationData[] = [];

  for (const legacyPath of LEGACY_NOTIFICATION_PATHS) {
    try {
      const legacyData = await fsp.readFile(legacyPath, 'utf8');
      const candidate = { path: legacyPath, data: legacyData };
      if (isNotificationHistoryJson(legacyData)) {
        return candidate;
      }
      readableData.push(candidate);
    } catch {
      // Continue to older legacy filenames.
    }
  }

  return readableData[0] ?? null;
}

function isNotificationHistoryJson(data: string): boolean {
  return parseNotificationHistory(data) !== null;
}

interface NotificationHistoryParseResult {
  notifications: StoredNotification[];
  recovered: boolean;
}

function parseNotificationHistory(data: string): NotificationHistoryParseResult | null {
  const parsed = parseNotificationHistoryArray(data);
  if (parsed) {
    return { notifications: parsed, recovered: false };
  }

  const firstArrayEnd = findFirstJsonArrayEnd(data);
  if (firstArrayEnd === null) {
    return null;
  }

  const recovered = parseNotificationHistoryArray(data.slice(0, firstArrayEnd));
  return recovered ? { notifications: recovered, recovered: true } : null;
}

function parseNotificationHistoryArray(data: string): StoredNotification[] | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    return Array.isArray(parsed) ? (parsed as StoredNotification[]) : null;
  } catch {
    return null;
  }
}

function findFirstJsonArrayEnd(data: string): number | null {
  const start = data.search(/\S/u);
  if (start === -1 || data[start] !== '[') {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < data.length; index++) {
    const char = data[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '[') {
      depth += 1;
      continue;
    }

    if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return null;
}

async function writeNotificationsFileAtomically(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`
  );

  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(tempPath, data, 'utf8');
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

// =============================================================================
// NotificationManager Class
// =============================================================================

export class NotificationManager extends EventEmitter {
  private static instance: NotificationManager | null = null;
  private notifications: StoredNotification[] = [];
  private configManager: ConfigManager;
  private mainWindow: BrowserWindow | null = null;
  private throttleMap = new Map<string, number>();
  private isInitialized: boolean = false;
  /**
   * Prevents GC from collecting Notification objects before they are dismissed.
   * On macOS, if the reference is lost, the notification may silently fail
   * and click handlers stop working after ~1-2 minutes.
   * @see https://blog.bloomca.me/2025/02/22/electron-mac-notifications.html
   */
  private activeNotifications = new Set<NotificationInstance>();
  /** Promise that resolves when async initialization is complete.
   *  Used by addError() to wait for notifications to be loaded from disk
   *  before writing, preventing a race where save overwrites unloaded data. */
  private initPromise: Promise<void> | null = null;
  private notificationsPath = NOTIFICATIONS_PATH;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(configManager?: ConfigManager) {
    super();
    this.configManager = configManager ?? ConfigManager.getInstance();
  }

  // ===========================================================================
  // Singleton Pattern
  // ===========================================================================

  /**
   * Gets the singleton instance of NotificationManager.
   */
  static getInstance(): NotificationManager {
    if (!NotificationManager.instance) {
      NotificationManager.instance = new NotificationManager();
      // Async init: loads notifications without blocking startup.
      // addError() awaits initPromise to prevent save-before-load races.
      NotificationManager.instance.initPromise = NotificationManager.instance.initialize();
    }
    return NotificationManager.instance;
  }

  /**
   * Resets the singleton instance (useful for testing).
   */
  static resetInstance(): void {
    NotificationManager.instance = null;
  }

  /**
   * Sets the singleton instance (useful for dependency injection).
   */
  static setInstance(instance: NotificationManager): void {
    NotificationManager.instance = instance;
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  /**
   * Initializes the notification manager.
   * Loads existing notifications and prunes if needed.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    this.notificationsPath = await migrateLegacyNotificationPath();
    await this.loadNotifications();
    this.pruneNotifications();
    this.isInitialized = true;

    logger.info(`NotificationManager: Initialized with ${this.notifications.length} notifications`);
  }

  /**
   * Sets the main window reference for sending IPC events.
   */
  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  // ===========================================================================
  // Persistence
  // ===========================================================================

  /**
   * Loads notifications from disk (async to avoid blocking startup).
   * Uses a single readFile instead of access() + readFile() to eliminate
   * a redundant syscall and TOCTOU race condition.
   */
  private async loadNotifications(): Promise<void> {
    try {
      const data = await fsp.readFile(this.notificationsPath, 'utf8');
      const parsed = parseNotificationHistory(data);

      if (!parsed) {
        logger.warn('Invalid notifications file format, starting fresh');
        this.notifications = [];
        return;
      }

      this.notifications = parsed.notifications;
      if (parsed.recovered) {
        logger.info('Recovered notifications from a corrupted history file, compacting storage');
        this.saveNotifications();
      }
    } catch (error) {
      // ENOENT is expected on first run — no file to load
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Error loading notifications:', error);
      }
      this.notifications = [];
    }
  }

  /**
   * Saves notifications to disk asynchronously.
   * Uses async I/O to avoid blocking the main process event loop,
   * which is critical on Windows where sync writes can freeze the UI.
   */
  private saveNotifications(): void {
    const data = JSON.stringify(this.notifications, null, 2);
    const notificationsPath = this.notificationsPath;

    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(() => writeNotificationsFileAtomically(notificationsPath, data))
      .catch((error) => {
        logger.error('Error saving notifications:', error);
      });
  }

  /**
   * Prunes notifications to MAX_NOTIFICATIONS entries.
   * Removes oldest notifications first.
   */
  private pruneNotifications(): void {
    if (this.notifications.length > MAX_NOTIFICATIONS) {
      // Sort by createdAt descending (newest first)
      this.notifications.sort((a, b) => b.createdAt - a.createdAt);

      // Keep only the newest MAX_NOTIFICATIONS
      const removed = this.notifications.length - MAX_NOTIFICATIONS;
      this.notifications = this.notifications.slice(0, MAX_NOTIFICATIONS);
      this.saveNotifications();

      logger.info(`NotificationManager: Pruned ${removed} old notifications`);
    }
  }

  // ===========================================================================
  // Error Filtering
  // ===========================================================================

  /**
   * Generates a unique hash for throttling based on projectId + message.
   */
  private generateErrorHash(error: DetectedError): string {
    return `${error.projectId}:${error.message}`;
  }

  /**
   * Checks if a native toast should be throttled.
   * Uses dedupeKey if present, else falls back to projectId:message hash.
   */
  private isToastThrottled(error: DetectedError): boolean {
    const key = error.dedupeKey ?? this.generateErrorHash(error);
    const lastSeen = this.throttleMap.get(key);

    if (lastSeen && Date.now() - lastSeen < THROTTLE_MS) {
      return true;
    }

    // Update throttle map
    this.throttleMap.set(key, Date.now());

    // Clean up old entries periodically
    this.cleanupThrottleMap();

    return false;
  }

  /**
   * Cleans up old entries from the throttle map.
   */
  private cleanupThrottleMap(): void {
    const now = Date.now();
    const expiredThreshold = now - THROTTLE_MS * 2;

    const keysToDelete: string[] = [];
    this.throttleMap.forEach((timestamp, hash) => {
      if (timestamp < expiredThreshold) {
        keysToDelete.push(hash);
      }
    });

    for (const key of keysToDelete) {
      this.throttleMap.delete(key);
    }
  }

  /**
   * Checks if notifications are currently enabled based on config.
   */
  private areNotificationsEnabled(): boolean {
    const config = this.configManager.getConfig();

    // Check if notifications are globally disabled
    if (!config.notifications.enabled) {
      return false;
    }

    // Check if notifications are snoozed
    if (config.notifications.snoozedUntil) {
      if (Date.now() < config.notifications.snoozedUntil) {
        return false;
      } else {
        // Snooze has expired, clear it
        this.configManager.clearSnooze();
      }
    }

    return true;
  }

  /**
   * Checks if an error matches any ignored regex patterns.
   */
  private matchesIgnoredRegex(error: DetectedError): boolean {
    const config = this.configManager.getConfig();
    const patterns = config.notifications.ignoredRegex;

    if (!patterns || patterns.length === 0) {
      return false;
    }

    for (const pattern of patterns) {
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(error.message)) {
          return true;
        }
      } catch {
        // Invalid regex pattern, skip
        logger.warn(`NotificationManager: Invalid regex pattern: ${pattern}`);
      }
    }

    return false;
  }

  /**
   * Checks if the error is from an ignored repository.
   * Resolves the project path to a repository ID and checks against ignored list.
   */
  private async isFromIgnoredRepository(error: DetectedError): Promise<boolean> {
    const config = this.configManager.getConfig();
    const ignoredRepositories = config.notifications.ignoredRepositories;

    if (!ignoredRepositories || ignoredRepositories.length === 0) {
      return false;
    }

    // Resolve project ID to repository ID using canonical path resolution.
    const projectPath = await projectPathResolver.resolveProjectPath(error.projectId, {
      cwdHint: error.context.cwd,
    });
    const identity = await gitIdentityResolver.resolveIdentity(path.normalize(projectPath));

    if (!identity) {
      return false;
    }

    return ignoredRepositories.includes(identity.id);
  }

  // ===========================================================================
  // Native Notifications
  // ===========================================================================

  /**
   * Shows a native notification for an error.
   * Closes over `stored` (StoredNotification) so click handler has full data.
   */
  private showErrorNativeNotification(stored: StoredNotification): void {
    const NotificationClass = getNotificationClass();
    if (!NotificationClass || !this.isNativeNotificationSupported()) return;

    const config = this.configManager.getConfig();
    const isMac = process.platform === 'darwin';
    const truncatedMessage = stripMarkdown(stored.message).slice(0, 200);
    const iconPath = isMac ? undefined : getAppIconPath();
    const notification = new NotificationClass({
      title: 'Claude Code Error',
      ...(isMac ? { subtitle: stored.context.projectName } : {}),
      body: isMac ? truncatedMessage : `${stored.context.projectName}\n${truncatedMessage}`,
      sound: config.notifications.soundEnabled ? 'default' : undefined,
      ...(iconPath ? { icon: iconPath } : {}),
    });

    // Hold a strong reference to prevent GC from collecting the notification
    this.activeNotifications.add(notification);
    const cleanup = (): void => {
      this.activeNotifications.delete(notification);
    };

    notification.on('click', () => {
      this.handleNativeNotificationClick(stored);
      cleanup();
    });
    notification.on('close', cleanup);

    notification.on('show', () => {
      logger.debug(`[notification] shown: "Claude Code Error" — ${stored.context.projectName}`);
    });
    notification.on('failed', (_, error) => {
      logger.warn(`[notification] failed: ${String(error)}`);
      cleanup();
    });

    notification.show();
  }

  /**
   * Shows a native notification for a team event.
   * Uses team-specific formatting (title = team name, subtitle = summary).
   */
  private showTeamNativeNotification(
    stored: StoredNotification,
    payload: TeamNotificationPayload
  ): void {
    const NotificationClass = getNotificationClass();
    if (!NotificationClass || !this.isNativeNotificationSupported()) {
      logger.warn('[team-toast] native notifications not supported — skipping');
      return;
    }

    try {
      const config = this.configManager.getConfig();
      const isMac = process.platform === 'darwin';
      const truncatedBody = stripMarkdown(stripAgentBlocks(payload.body)).slice(0, 300);
      const iconPath = isMac ? undefined : getAppIconPath();

      logger.debug(
        `[team-toast] creating: title="${payload.teamDisplayName}" summary="${payload.summary ?? ''}" bodyLen=${truncatedBody.length}`
      );

      const notification = new NotificationClass({
        title: payload.teamDisplayName,
        ...(isMac ? { subtitle: payload.summary } : {}),
        body: !isMac && payload.summary ? `${payload.summary}\n${truncatedBody}` : truncatedBody,
        sound: config.notifications.soundEnabled ? 'default' : undefined,
        ...(iconPath ? { icon: iconPath } : {}),
      });

      // Hold a strong reference to prevent GC from collecting the notification
      this.activeNotifications.add(notification);
      const cleanup = (): void => {
        this.activeNotifications.delete(notification);
      };

      notification.on('click', () => {
        this.handleNativeNotificationClick(stored);
        cleanup();
      });
      notification.on('close', cleanup);

      notification.on('show', () => {
        logger.debug(
          `[team-toast] OS confirmed show: "${payload.teamDisplayName}" — ${payload.summary ?? ''}`
        );
      });
      notification.on('failed', (_, error) => {
        logger.warn(`[team-toast] OS failed: ${String(error)}`);
        cleanup();
      });

      notification.show();
      logger.debug('[team-toast] notification.show() called');
    } catch (error) {
      logger.error(`[team-toast] exception in showTeamNativeNotification: ${String(error)}`);
    }
  }

  /**
   * Shared click handler for native notifications — focuses window and emits deep-link.
   */
  private handleNativeNotificationClick(stored: StoredNotification): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.show();
      this.mainWindow.focus();
      safeSendToRenderer(this.mainWindow, 'notification:clicked', stored);
    }
    this.emit('notification-clicked', stored);
  }

  /**
   * Guard: checks if Electron's Notification API is available.
   */
  private isNativeNotificationSupported(): boolean {
    const Notification = getNotificationClass();
    if (
      !Notification ||
      typeof Notification.isSupported !== 'function' ||
      !Notification.isSupported()
    ) {
      logger.warn('Native notifications not supported');
      return false;
    }
    return true;
  }

  // ===========================================================================
  // Test Notification
  // ===========================================================================

  /**
   * Sends a test notification to verify that native notifications work.
   * Returns a result object indicating success or failure reason.
   */
  sendTestNotification(): { success: boolean; error?: string } {
    const NotificationClass = getNotificationClass();
    if (!NotificationClass || !this.isNativeNotificationSupported()) {
      logger.warn('[test-notification] native notifications not supported');
      return { success: false, error: 'Native notifications are not supported on this platform' };
    }

    const isMac = process.platform === 'darwin';
    const iconPath = isMac ? undefined : getAppIconPath();
    logger.debug(`[test-notification] creating Notification (platform=${process.platform})`);
    const notification = new NotificationClass({
      title: 'Test Notification',
      ...(isMac ? { subtitle: 'Agent Teams UI' } : {}),
      body: isMac
        ? 'Notifications are working correctly!'
        : 'Agent Teams UI\nNotifications are working correctly!',
      ...(iconPath ? { icon: iconPath } : {}),
    });

    // Hold a strong reference to prevent GC
    this.activeNotifications.add(notification);
    const cleanup = (): void => {
      this.activeNotifications.delete(notification);
    };

    notification.on('click', cleanup);
    notification.on('close', cleanup);

    notification.on('show', () => {
      logger.debug('[notification] test notification shown successfully');
    });
    notification.on('failed', (_, error) => {
      logger.warn(`[notification] test notification failed: ${String(error)}`);
      cleanup();
    });

    notification.show();
    return { success: true };
  }

  // ===========================================================================
  // IPC Event Emission
  // ===========================================================================

  /**
   * Emits a notification:new event to the renderer.
   */
  private emitNewNotification(notification: StoredNotification): void {
    safeSendToRenderer(this.mainWindow, 'notification:new', notification);

    this.emit('notification-new', notification);
  }

  /**
   * Emits a notification:updated event to the renderer.
   */
  private emitNotificationUpdated(): void {
    safeSendToRenderer(this.mainWindow, 'notification:updated', {
      total: this.notifications.length,
      unreadCount: this.getUnreadCountSync(),
    });

    this.emit('notification-updated', {
      total: this.notifications.length,
      unreadCount: this.getUnreadCountSync(),
    });
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Stores a notification unconditionally. Emits IPC events to renderer.
   * Returns null if dedupeKey already exists in storage (storage-level dedupe)
   * or if toolUseId-based dedup skips it.
   */
  private async storeNotification(error: DetectedError): Promise<StoredNotification | null> {
    if (this.initPromise) {
      await this.initPromise;
    }

    // Storage-level dedupe by dedupeKey (persistent, lives as long as notification is in storage)
    if (error.dedupeKey) {
      const exists = this.notifications.some((n) => n.dedupeKey === error.dedupeKey);
      if (exists) return null;
    }

    // Deduplicate by toolUseId: the same tool call can appear in both the
    // subagent JSONL file and the parent session JSONL (as a progress event).
    // Keep the subagent-annotated version (with subagentId) when possible.
    if (error.toolUseId) {
      const existingIndex = this.notifications.findIndex((n) => n.toolUseId === error.toolUseId);
      if (existingIndex !== -1) {
        const existing = this.notifications[existingIndex];
        if (!existing.subagentId && error.subagentId) {
          // Replace: prefer the subagent-annotated version
          this.notifications.splice(existingIndex, 1);
        } else {
          // Already have a (better or equal) version — skip
          return null;
        }
      }
    }

    const storedNotification: StoredNotification = {
      ...error,
      isRead: false,
      createdAt: Date.now(),
    };

    // Add to the beginning of the list (newest first)
    this.notifications.unshift(storedNotification);

    // Prune if needed
    this.pruneNotifications();

    // Save to disk
    this.saveNotifications();

    // Emit new notification event
    this.emitNewNotification(storedNotification);
    // Emit authoritative counters (total/unread) so renderer badge stays in sync.
    this.emitNotificationUpdated();

    return storedNotification;
  }

  /**
   * Adds an error notification. Storage is unconditional; native toast respects
   * enabled/snoozed, ignored repos, ignored regex, and 5s throttle.
   */
  async addError(error: DetectedError): Promise<StoredNotification | null> {
    const stored = await this.storeNotification(error);
    if (!stored) return null;

    // Error-specific toast policy: repo filter + regex filter + enabled/snoozed + throttle
    if (
      this.areNotificationsEnabled() &&
      !(await this.isFromIgnoredRepository(error)) &&
      !this.matchesIgnoredRegex(error) &&
      !this.isToastThrottled(error)
    ) {
      this.showErrorNativeNotification(stored);
    }

    return stored;
  }

  /**
   * Adds a team notification. Storage is unconditional; native toast respects
   * enabled/snoozed, suppressToast flag, and 5s dedupeKey-based throttle.
   * Skips repo/regex filters (not applicable to team events).
   */
  async addTeamNotification(payload: TeamNotificationPayload): Promise<StoredNotification | null> {
    const error = buildDetectedErrorFromTeam(payload);
    const stored = await this.storeNotification(error);
    if (!stored) {
      logger.debug(
        `[team-notification] skipped (dedup): type=${payload.teamEventType} key=${payload.dedupeKey}`
      );
      return null;
    }

    // Team-specific toast policy: enabled/snoozed + suppressToast + dedupeKey throttle only
    const enabled = this.areNotificationsEnabled();
    const throttled = this.isToastThrottled(error);
    const shouldShow = !payload.suppressToast && enabled && !throttled;
    logger.debug(
      `[team-notification] toast decision: type=${payload.teamEventType} suppressToast=${String(payload.suppressToast ?? false)} enabled=${String(enabled)} throttled=${String(throttled)} → show=${String(shouldShow)}`
    );
    if (shouldShow) {
      this.showTeamNativeNotification(stored, payload);
    }

    return stored;
  }

  /**
   * Gets a paginated list of notifications.
   * @param options - Pagination options
   * @returns Paginated notifications result
   */
  async getNotifications(options?: GetNotificationsOptions): Promise<GetNotificationsResult> {
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;

    // Notifications are already sorted newest first
    const notifications = this.notifications.slice(offset, offset + limit);
    const total = this.notifications.length;
    const hasMore = offset + notifications.length < total;

    return {
      notifications,
      total,
      totalCount: total,
      unreadCount: this.getUnreadCountSync(),
      hasMore,
    };
  }

  /**
   * Marks a notification as read.
   * @param id - The notification ID to mark as read
   * @returns true if found and marked, false otherwise
   */
  async markRead(id: string): Promise<boolean> {
    const notification = this.notifications.find((n) => n.id === id);

    if (!notification) {
      return false;
    }

    if (!notification.isRead) {
      notification.isRead = true;
      this.saveNotifications();
      this.emitNotificationUpdated();
    }

    return true;
  }

  /**
   * Marks all notifications as read.
   * @returns true on success
   */
  async markAllRead(): Promise<boolean> {
    let changed = false;

    for (const notification of this.notifications) {
      if (!notification.isRead) {
        notification.isRead = true;
        changed = true;
      }
    }

    if (changed) {
      this.saveNotifications();
      this.emitNotificationUpdated();
    }

    return true;
  }

  /**
   * Clears all notifications.
   */
  clear(): void {
    this.notifications = [];
    this.saveNotifications();
    this.emitNotificationUpdated();
  }

  /**
   * Clears all notifications (async version for IPC).
   * @returns true on success
   */
  async clearAll(): Promise<boolean> {
    this.clear();
    return true;
  }

  /**
   * Gets the count of unread notifications.
   * @returns Number of unread notifications (Promise for IPC compatibility)
   */
  async getUnreadCount(): Promise<number> {
    return this.notifications.filter((n) => !n.isRead).length;
  }

  /**
   * Gets the count of unread notifications (sync version).
   * @returns Number of unread notifications
   */
  getUnreadCountSync(): number {
    return this.notifications.filter((n) => !n.isRead).length;
  }

  /**
   * Gets a specific notification by ID.
   * @param id - The notification ID
   * @returns The notification or undefined if not found
   */
  getNotification(id: string): StoredNotification | undefined {
    return this.notifications.find((n) => n.id === id);
  }

  /**
   * Deletes a specific notification.
   * @param id - The notification ID to delete
   * @returns true if found and deleted, false otherwise
   */
  deleteNotification(id: string): boolean {
    const index = this.notifications.findIndex((n) => n.id === id);

    if (index === -1) {
      return false;
    }

    this.notifications.splice(index, 1);
    this.saveNotifications();
    this.emitNotificationUpdated();

    return true;
  }

  // ===========================================================================
  // Stats
  // ===========================================================================

  /**
   * Gets statistics about notifications.
   */
  getStats(): {
    total: number;
    unread: number;
    byProject: Record<string, number>;
    bySource: Record<string, number>;
  } {
    const byProject: Record<string, number> = {};
    const bySource: Record<string, number> = {};

    for (const notification of this.notifications) {
      const projectName = notification.context.projectName;
      byProject[projectName] = (byProject[projectName] || 0) + 1;

      bySource[notification.source] = (bySource[notification.source] || 0) + 1;
    }

    return {
      total: this.notifications.length,
      unread: this.getUnreadCountSync(),
      byProject,
      bySource,
    };
  }
}
