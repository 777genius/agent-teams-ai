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
import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { getAppDataPath, getHomeDir, getTeamsBasePath } from '@main/utils/pathDecoder';
import { safeSendToRenderer } from '@main/utils/safeWebContentsSend';
import { stripMarkdown } from '@main/utils/textFormatting';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import {
  getMemberColorByName,
  MEMBER_COLOR_HUE,
  PARTICIPANT_IDENTITY_COLOR_PALETTE,
} from '@shared/constants/memberColors';
import { isLeadMember } from '@shared/utils/leadDetection';
import { createLogger } from '@shared/utils/logger';
import { nativeImage, Notification as ElectronNotification } from 'electron';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';

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
const SENDER_ICON_CACHE = new Map<string, NotificationConstructorOptions['icon'] | undefined>();
const WINDOWS_TOAST_AVATAR_CACHE = new Map<string, string | undefined>();
/**
 * Sender icons are decoded NativeImages (~260KB each), keyed per team+member.
 * Bound both caches so long sessions across many teams cannot grow them
 * without limit; eviction is FIFO (oldest inserted entry first).
 */
const NOTIFICATION_CACHE_MAX_ENTRIES = 128;

function setBoundedCacheEntry<K, V>(cache: Map<K, V>, key: K, value: V): void {
  if (!cache.has(key) && cache.size >= NOTIFICATION_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next();
    if (!oldestKey.done) {
      cache.delete(oldestKey.value);
    }
  }
  cache.set(key, value);
}
const PARTICIPANT_AVATAR_COUNT = PARTICIPANT_IDENTITY_COLOR_PALETTE.length;
const LEAD_PARTICIPANT_AVATAR_NUMBER = 1;

interface TeamNotificationAvatarMember {
  name: string;
  removedAt?: number | string | null;
  agentType?: string;
}

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

function getNativeImage(): typeof nativeImage | null {
  return nativeImage && typeof nativeImage.createFromPath === 'function' ? nativeImage : null;
}

function hashStringToIndex(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function getParticipantAvatarNumberByIndex(index: number): number {
  const normalized =
    ((Math.trunc(index) % PARTICIPANT_AVATAR_COUNT) + PARTICIPANT_AVATAR_COUNT) %
    PARTICIPANT_AVATAR_COUNT;
  return normalized + 1;
}

function getFallbackParticipantAvatarNumber(name: string): number {
  const normalized = name.trim().toLowerCase();
  if (normalized === 'team-lead' || normalized === 'lead') {
    return LEAD_PARTICIPANT_AVATAR_NUMBER;
  }
  return getParticipantAvatarNumberByIndex(hashStringToIndex(normalized));
}

function getParticipantAvatarNumber(
  sender: string,
  members: readonly TeamNotificationAvatarMember[]
): number {
  const senderName = sender.trim();
  if (!senderName) return getFallbackParticipantAvatarNumber(sender);

  const map = new Map<string, number>();
  const activeMembers = members.filter((member) => !member.removedAt);
  const leadMembers = activeMembers.filter((member) => isLeadMember(member));
  const teammateMembers = activeMembers.filter((member) => !isLeadMember(member));

  for (const [index, member] of leadMembers.entries()) {
    map.set(
      member.name,
      index === 0 ? LEAD_PARTICIPANT_AVATAR_NUMBER : getFallbackParticipantAvatarNumber(member.name)
    );
  }

  for (const [index, member] of teammateMembers.entries()) {
    map.set(member.name, 2 + (index % (PARTICIPANT_AVATAR_COUNT - 1)));
  }

  for (const member of members) {
    if (!map.has(member.name)) {
      map.set(
        member.name,
        isLeadMember(member)
          ? LEAD_PARTICIPANT_AVATAR_NUMBER
          : getFallbackParticipantAvatarNumber(member.name)
      );
    }
  }

  map.set('user', getFallbackParticipantAvatarNumber('user'));
  map.set('system', getFallbackParticipantAvatarNumber('system'));

  return map.get(senderName) ?? getFallbackParticipantAvatarNumber(senderName);
}

function readTeamNotificationMembers(teamName: string): TeamNotificationAvatarMember[] {
  try {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    if (!existsSync(configPath)) return [];

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
      members?: unknown;
    };
    if (!Array.isArray(parsed.members)) return [];

    return parsed.members
      .map((member): TeamNotificationAvatarMember | null => {
        if (!member || typeof member !== 'object') return null;
        const record = member as Record<string, unknown>;
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        if (!name) return null;
        return {
          name,
          removedAt:
            typeof record.removedAt === 'number' || typeof record.removedAt === 'string'
              ? record.removedAt
              : null,
          agentType: typeof record.agentType === 'string' ? record.agentType : undefined,
        };
      })
      .filter((member): member is TeamNotificationAvatarMember => Boolean(member));
  } catch (error) {
    logger.debug(`[team-toast] failed to read team members for avatar: ${String(error)}`);
    return [];
  }
}

function resolveParticipantAvatarPath(avatarNumber: number): string | undefined {
  const filename = `${String(avatarNumber).padStart(2, '0')}.png`;
  const resourceRoot =
    typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0
      ? process.resourcesPath
      : null;
  const candidates = [
    path.join(process.cwd(), 'src/renderer/assets/participant-avatars', filename),
    ...(resourceRoot ? [path.join(resourceRoot, 'participant-avatars', filename)] : []),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatSenderLabel(sender: string): string | null {
  const trimmed = sender.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === 'system') return 'System';
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

function cleanNotificationText(value: string): string {
  return stripMarkdown(stripAgentBlocks(value)).replace(/\s+/g, ' ').trim();
}

function truncateNotificationText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function extractTaskRef(summary: string): string | null {
  const match = /#([A-Za-z0-9][A-Za-z0-9-]*)/.exec(summary);
  return match ? `#${match[1]}` : null;
}

function extractTaskSubject(summary: string): string {
  return summary
    .replace(/^Comment on\s+#[^:]+:\s*/i, '')
    .replace(/^Comment on\s+#[^\s]+/i, '')
    .replace(/^Clarification needed\s+[-–—]\s+Task\s+#[^:]+:\s*/i, '')
    .replace(/^Clarification needed\s+[-–—]\s+Task\s+#[^\s]+/i, '')
    .replace(/^Review requested\s+#[^:]+:\s*/i, '')
    .replace(/^Review requested\s+#[^\s]+/i, '')
    .replace(/^Blocked\s+#[^:]+:\s*/i, '')
    .replace(/^Blocked\s+#[^\s]+/i, '')
    .replace(/^New task\s+#[^:]+:\s*/i, '')
    .replace(/^New task\s+#[^\s]+/i, '')
    .replace(/^Task\s+#[^:]+:\s*/i, '')
    .trim();
}

function getTeamNotificationAction(
  payload: TeamNotificationPayload,
  taskRef: string | null
): string {
  switch (payload.teamEventType) {
    case 'task_comment':
      return taskRef ? `commented on ${taskRef}` : 'commented on a task';
    case 'task_clarification':
      return taskRef ? `needs your reply on ${taskRef}` : 'needs your reply';
    case 'task_review_requested':
      return taskRef ? `requested review on ${taskRef}` : 'requested review';
    case 'task_blocked': {
      const sender = payload.from.trim().toLowerCase();
      if (sender === 'system') return taskRef ? `Task is blocked on ${taskRef}` : 'Task is blocked';
      return taskRef ? `is blocked on ${taskRef}` : 'is blocked';
    }
    case 'task_status_change':
      return taskRef ? `changed ${taskRef}` : 'changed task status';
    case 'task_created':
      return taskRef ? `created ${taskRef}` : 'created a task';
    case 'all_tasks_completed':
      return 'completed all tasks';
    case 'lead_inbox':
    case 'user_inbox':
      return 'sent a message';
    case 'cross_team_message':
      return 'sent a cross-team message';
    case 'rate_limit':
      return 'paused: rate limit';
    case 'api_error':
      return 'paused: API error';
    case 'schedule_completed':
      return 'completed a schedule';
    case 'schedule_failed':
      return 'schedule failed';
    case 'team_launched':
      return 'launched a team';
    default:
      return 'sent an update';
  }
}

function getTeamNotificationWhere(
  payload: TeamNotificationPayload,
  taskRef: string | null
): string {
  const team = cleanNotificationText(payload.teamDisplayName) || payload.teamDisplayName;
  const summary = cleanNotificationText(payload.summary);

  if (payload.teamEventType.startsWith('task_')) {
    const subject = extractTaskSubject(summary);
    const taskContext = subject || taskRef;
    return taskContext ? `${taskContext} - ${team}` : team;
  }

  return team;
}

function buildTeamNotificationPresentation(
  payload: TeamNotificationPayload,
  body: string
): { title: string; where: string; body: string } {
  const who = formatSenderLabel(payload.from) ?? cleanNotificationText(payload.teamDisplayName);
  const summary = cleanNotificationText(payload.summary);
  const taskRef = extractTaskRef(summary);
  const action = getTeamNotificationAction(payload, taskRef);
  const where = getTeamNotificationWhere(payload, taskRef);
  const normalizedBody = cleanNotificationText(body);

  if (payload.teamEventType === 'team_launch_incomplete') {
    return {
      title: 'Team launch incomplete',
      where: truncateNotificationText(where, 120),
      body: truncateNotificationText(normalizedBody || summary, 300),
    };
  }

  if (payload.teamEventType === 'task_blocked' && payload.from.trim().toLowerCase() === 'system') {
    return {
      title: truncateNotificationText(action, 96),
      where: truncateNotificationText(where, 120),
      body: truncateNotificationText(normalizedBody || summary, 300),
    };
  }

  return {
    title: truncateNotificationText(`${who} ${action}`.trim(), 96),
    where: truncateNotificationText(where, 120),
    body: truncateNotificationText(normalizedBody || summary, 300),
  };
}

function getSenderInitials(sender: string): string {
  const trimmed = sender.trim().replace(/^@+/, '');
  if (!trimmed) return '?';

  const parts = trimmed.split(/[\s._:-]+/).filter(Boolean);
  const initials =
    parts.length >= 2
      ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`
      : trimmed.replace(/[\s._:-]+/g, '').slice(0, 2);

  return initials.toLocaleUpperCase() || '?';
}

function resolveSenderParticipantAvatarPath(
  sender: string,
  teamName: string,
  members: readonly TeamNotificationAvatarMember[] | undefined
): string | undefined {
  const senderLabel = sender.trim();
  if (!senderLabel || senderLabel.toLowerCase() === 'system') return undefined;

  const roster = members && members.length > 0 ? members : readTeamNotificationMembers(teamName);
  const avatarNumber = getParticipantAvatarNumber(senderLabel, roster);
  return resolveParticipantAvatarPath(avatarNumber);
}

function getWindowsToastAvatarPath(avatarPath: string): string {
  const cached = WINDOWS_TOAST_AVATAR_CACHE.get(avatarPath);
  if (cached) return cached;

  const NativeImage = getNativeImage();
  if (!NativeImage) {
    setBoundedCacheEntry(WINDOWS_TOAST_AVATAR_CACHE, avatarPath, avatarPath);
    return avatarPath;
  }

  try {
    const source = NativeImage.createFromPath(avatarPath);
    if (source.isEmpty()) {
      setBoundedCacheEntry(WINDOWS_TOAST_AVATAR_CACHE, avatarPath, avatarPath);
      return avatarPath;
    }

    const resized = source.resize({ width: 96, height: 96 });
    if (resized.isEmpty()) {
      setBoundedCacheEntry(WINDOWS_TOAST_AVATAR_CACHE, avatarPath, avatarPath);
      return avatarPath;
    }

    const cacheDir = path.join(getAppDataPath(), 'notification-avatars');
    mkdirSync(cacheDir, { recursive: true });

    const parsed = path.parse(avatarPath);
    const outPath = path.join(cacheDir, `${parsed.name}-96.png`);
    writeFileSync(outPath, resized.toPNG());
    setBoundedCacheEntry(WINDOWS_TOAST_AVATAR_CACHE, avatarPath, outPath);
    return outPath;
  } catch (error) {
    logger.debug(`[team-toast] failed to prepare Windows toast avatar: ${String(error)}`);
    setBoundedCacheEntry(WINDOWS_TOAST_AVATAR_CACHE, avatarPath, avatarPath);
    return avatarPath;
  }
}

function buildSenderNotificationIcon(
  sender: string,
  teamName: string,
  members: readonly TeamNotificationAvatarMember[] | undefined
): NotificationConstructorOptions['icon'] {
  const senderLabel = sender.trim();
  if (!senderLabel || senderLabel.toLowerCase() === 'system') return getAppIconPath();

  const senderAvatarPath = resolveSenderParticipantAvatarPath(senderLabel, teamName, members);
  const cacheKey = `${teamName}:${senderLabel}:${senderAvatarPath ?? 'generated'}`.toLowerCase();
  if (SENDER_ICON_CACHE.has(cacheKey)) {
    return SENDER_ICON_CACHE.get(cacheKey);
  }

  try {
    if (senderAvatarPath) {
      const NativeImage = getNativeImage();
      if (NativeImage) {
        const avatarIcon = NativeImage.createFromPath(senderAvatarPath);
        if (!avatarIcon.isEmpty()) {
          setBoundedCacheEntry(SENDER_ICON_CACHE, cacheKey, avatarIcon);
          return avatarIcon;
        }
      }
    }

    const colorName = getMemberColorByName(senderLabel);
    const hue = MEMBER_COLOR_HUE[colorName] ?? 210;
    const initials = escapeXmlAttribute(getSenderInitials(senderLabel));
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">',
      `<rect width="256" height="256" rx="72" fill="hsl(${hue}, 68%, 38%)"/>`,
      `<circle cx="128" cy="128" r="102" fill="hsl(${hue}, 74%, 46%)"/>`,
      `<circle cx="91" cy="86" r="20" fill="hsl(${hue}, 84%, 72%)" opacity="0.9"/>`,
      `<path d="M54 178c23-31 48-46 74-46s51 15 74 46" fill="none" stroke="hsl(${hue}, 88%, 78%)" stroke-width="18" stroke-linecap="round" opacity="0.5"/>`,
      `<text x="128" y="148" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="78" font-weight="700" fill="#fff">${initials}</text>`,
      '</svg>',
    ].join('');
    const NativeImage = getNativeImage();
    const icon = NativeImage?.createFromDataURL(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    );
    const resolvedIcon = icon && !icon.isEmpty() ? icon : getAppIconPath();
    setBoundedCacheEntry(SENDER_ICON_CACHE, cacheKey, resolvedIcon);
    return resolvedIcon;
  } catch (error) {
    logger.debug(`[team-toast] sender icon fallback for "${senderLabel}": ${String(error)}`);
    const fallbackIcon = getAppIconPath();
    setBoundedCacheEntry(SENDER_ICON_CACHE, cacheKey, fallbackIcon);
    return fallbackIcon;
  }
}

function buildWindowsTeamToastXml(input: {
  title: string;
  summary?: string;
  body: string;
  sender: string;
  avatarPath?: string;
  silent: boolean;
}): string {
  const textRows = [
    `<text>${escapeXmlText(input.title)}</text>`,
    input.summary ? `<text>${escapeXmlText(input.summary)}</text>` : null,
    input.body ? `<text>${escapeXmlText(input.body)}</text>` : null,
  ].filter(Boolean);

  const avatarRow = input.avatarPath
    ? `<image placement="appLogoOverride" hint-crop="circle" src="${escapeXmlAttribute(
        pathToFileURL(input.avatarPath).href
      )}" alt="${escapeXmlAttribute(`${input.sender} avatar`)}"/>`
    : null;

  return [
    '<toast>',
    '<visual>',
    '<binding template="ToastGeneric">',
    ...textRows,
    avatarRow,
    '</binding>',
    '</visual>',
    input.silent ? '<audio silent="true"/>' : null,
    '</toast>',
  ]
    .filter(Boolean)
    .join('');
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
  await atomicWriteAsync(filePath, data);
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
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return;
        }
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
      title: 'Agent Teams Error',
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
      logger.debug(`[notification] shown: "Agent Teams Error" - ${stored.context.projectName}`);
    });
    notification.on('failed', (_, error) => {
      logger.warn(`[notification] failed: ${String(error)}`);
      cleanup();
    });

    notification.show();
  }

  /**
   * Shows a native notification for a team event.
   * Uses a consistent who + what + where presentation for all team events.
   */
  private showTeamNativeNotification(
    stored: StoredNotification,
    payload: TeamNotificationPayload
  ): void {
    const NotificationClass = getNotificationClass();
    if (!NotificationClass || !this.isNativeNotificationSupported()) {
      logger.debug('[team-toast] native notifications not supported - skipping');
      return;
    }

    try {
      const config = this.configManager.getConfig();
      const isMac = process.platform === 'darwin';
      const presentation = buildTeamNotificationPresentation(payload, payload.body);
      const senderAvatarPath = resolveSenderParticipantAvatarPath(
        payload.from,
        payload.teamName,
        payload.members
      );
      const toastXml =
        process.platform === 'win32' && senderAvatarPath
          ? buildWindowsTeamToastXml({
              title: presentation.title,
              summary: presentation.where,
              body: presentation.body,
              sender: payload.from,
              avatarPath: getWindowsToastAvatarPath(senderAvatarPath),
              silent: !config.notifications.soundEnabled,
            })
          : undefined;
      const senderIcon = toastXml
        ? undefined
        : buildSenderNotificationIcon(payload.from, payload.teamName, payload.members);

      logger.debug(
        `[team-toast] creating: title="${presentation.title}" where="${presentation.where}" bodyLen=${presentation.body.length}`
      );

      const notificationOptions: NotificationConstructorOptions = toastXml
        ? { toastXml }
        : {
            title: presentation.title,
            ...(isMac ? { subtitle: presentation.where } : {}),
            body:
              !isMac && presentation.where
                ? `${presentation.where}\n${presentation.body}`
                : presentation.body,
            sound: config.notifications.soundEnabled ? 'default' : undefined,
            ...(senderIcon ? { icon: senderIcon } : {}),
          };

      const notification = new NotificationClass(notificationOptions);

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
          `[team-toast] OS confirmed show: "${presentation.title}" - ${presentation.where}`
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
    const isDevRuntime =
      process.env.NODE_ENV !== 'production' ||
      Boolean((process as typeof process & { defaultApp?: boolean }).defaultApp);
    if (isDevRuntime) {
      const notificationType = stored.teamEventType ?? stored.category ?? 'error';
      const notificationTitle = stored.triggerName ?? stored.message;
      logger.info(
        `[notification-click] delivered in-process id=${stored.id} type=${notificationType} title="${notificationTitle}"`
      );
    }

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.show();
      this.mainWindow.focus();
      safeSendToRenderer(this.mainWindow, 'notification:clicked', stored);
    }
    this.emit('notification-clicked', stored);
  }

  /**
   * Closes active OS notifications so macOS does not keep stale dev toasts that
   * can relaunch raw Electron without the app path.
   */
  closeActiveNativeNotifications(reason: string = 'manual'): number {
    const notifications = Array.from(this.activeNotifications);
    for (const notification of notifications) {
      try {
        (notification as NotificationInstance & { close?: () => void }).close?.();
      } catch (error) {
        logger.debug(
          `[notification] failed to close active notification during ${reason}: ${String(error)}`
        );
      }
    }
    this.activeNotifications.clear();
    if (notifications.length > 0) {
      logger.debug(
        `[notification] closed ${notifications.length} active notification(s): ${reason}`
      );
    }
    return notifications.length;
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
      ...(isMac ? { subtitle: 'Agent Teams AI' } : {}),
      body: isMac
        ? 'Notifications are working correctly!'
        : 'Agent Teams AI\nNotifications are working correctly!',
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
