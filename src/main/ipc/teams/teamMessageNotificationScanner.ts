import { ConfigManager } from '@main/services/infrastructure/ConfigManager';
import { NotificationManager } from '@main/services/infrastructure/NotificationManager';
import {
  getAutoResumeService,
  planRateLimitAutoResume,
  type RateLimitAutoResumePlan,
} from '@main/services/team/AutoResumeService';
import { isApiErrorMessage } from '@shared/utils/apiErrorDetector';
import { isRateLimitMessage } from '@shared/utils/rateLimitDetector';

import type { TeamNotificationPayload } from '@main/utils/teamNotificationBuilder';

export interface TeamNotificationMessage {
  messageId?: string;
  from: string;
  text: string;
  timestamp: string;
  to?: string;
  source?: string;
  leadSessionId?: string;
}

interface TeamNotificationSink {
  addTeamNotification(payload: TeamNotificationPayload): Promise<unknown>;
}

interface AutoResumeSink {
  handleRateLimitMessage(
    teamName: string,
    messageText: string,
    observedAt: Date,
    messageTimestamp: Date
  ): void;
}

interface ConfigReader {
  getConfig(): {
    notifications: {
      autoResumeOnRateLimit: boolean;
    };
  };
}

export interface TeamMessageNotificationScannerDeps {
  configReader?: ConfigReader;
  notificationSink?: TeamNotificationSink;
  autoResumeSink?: AutoResumeSink;
  planAutoResume?: typeof planRateLimitAutoResume;
  isRateLimit?: (text: string) => boolean;
  isApiError?: (text: string) => boolean;
  now?: () => Date;
  formatClockTime?: (date: Date) => string;
}

export interface TeamMessageNotificationContext {
  teamName: string;
  teamDisplayName: string;
  projectPath?: string;
  teamIsAlive?: boolean;
  currentLeadSessionId?: string | null;
}

const SEEN_RATE_LIMIT_KEYS_MAX = 500;
const SEEN_API_ERROR_KEYS_MAX = 500;

function formatNotificationClockTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function buildRateLimitNotificationBody(
  plan: RateLimitAutoResumePlan,
  formatClockTime: (date: Date) => string
): string {
  if (plan.kind === 'scheduled') {
    return `Auto-resume scheduled at ${formatClockTime(new Date(plan.fireAtMs))}`;
  }
  return 'Manual restart needed';
}

function evictOldestIfNeeded(keys: Set<string>, maxSize: number): void {
  if (keys.size <= maxSize) {
    return;
  }

  const first = keys.values().next().value;
  if (first) {
    keys.delete(first);
  }
}

function createDefaultNotificationSink(): TeamNotificationSink {
  return {
    addTeamNotification: (payload) => NotificationManager.getInstance().addTeamNotification(payload),
  };
}

export class TeamMessageNotificationScanner {
  readonly #seenRateLimitKeys = new Set<string>();
  readonly #seenApiErrorKeys = new Set<string>();
  readonly #configReader: ConfigReader;
  readonly #notificationSink: TeamNotificationSink;
  readonly #planAutoResume: typeof planRateLimitAutoResume;
  readonly #isRateLimit: (text: string) => boolean;
  readonly #isApiError: (text: string) => boolean;
  readonly #now: () => Date;
  readonly #formatClockTime: (date: Date) => string;
  readonly #autoResumeSink: AutoResumeSink | null;

  constructor(deps: TeamMessageNotificationScannerDeps = {}) {
    this.#configReader = deps.configReader ?? ConfigManager.getInstance();
    this.#notificationSink = deps.notificationSink ?? createDefaultNotificationSink();
    this.#planAutoResume = deps.planAutoResume ?? planRateLimitAutoResume;
    this.#isRateLimit = deps.isRateLimit ?? isRateLimitMessage;
    this.#isApiError = deps.isApiError ?? isApiErrorMessage;
    this.#now = deps.now ?? (() => new Date());
    this.#formatClockTime = deps.formatClockTime ?? formatNotificationClockTime;
    this.#autoResumeSink = deps.autoResumeSink ?? null;
  }

  checkRateLimitMessages(
    messages: readonly TeamNotificationMessage[],
    context: TeamMessageNotificationContext
  ): void {
    const observedAt = this.#now();
    const autoResumeEnabled = this.#configReader.getConfig().notifications.autoResumeOnRateLimit;

    for (const msg of messages) {
      if (msg.from === 'user') continue;
      if (!this.#isRateLimit(msg.text)) continue;

      const rawKey = msg.messageId ?? `${msg.from}:${msg.timestamp}`;
      const dedupeKey = `rate-limit:${context.teamName}:${rawKey}`;
      const isLeadAutoResumeCandidate =
        !msg.to && (msg.source === 'lead_process' || msg.source === 'lead_session');
      const currentLeadSessionId = context.currentLeadSessionId ?? null;
      const autoResumeSessionMatches =
        msg.source !== 'lead_session' ||
        (Boolean(currentLeadSessionId) && msg.leadSessionId === currentLeadSessionId);
      const autoResumePlan = this.#planAutoResume({
        enabled: autoResumeEnabled,
        canAutoResume:
          (context.teamIsAlive ?? true) &&
          isLeadAutoResumeCandidate &&
          autoResumeSessionMatches,
        messageText: msg.text,
        observedAt,
        messageTimestamp: new Date(msg.timestamp),
      });

      if (!this.#seenRateLimitKeys.has(dedupeKey)) {
        this.#seenRateLimitKeys.add(dedupeKey);
        evictOldestIfNeeded(this.#seenRateLimitKeys, SEEN_RATE_LIMIT_KEYS_MAX);

        void this.#notificationSink
          .addTeamNotification({
            teamEventType: 'rate_limit',
            teamName: context.teamName,
            teamDisplayName: context.teamDisplayName,
            from: msg.from,
            summary: 'Rate limit',
            body: buildRateLimitNotificationBody(autoResumePlan, this.#formatClockTime),
            dedupeKey,
            target: {
              kind: 'member',
              teamName: context.teamName,
              memberName: msg.from,
              focus: 'logs',
            },
            projectPath: context.projectPath,
          })
          .catch(() => undefined);
      }

      if (autoResumePlan.kind === 'scheduled') {
        const autoResumeSink = this.#autoResumeSink ?? getAutoResumeService();
        autoResumeSink.handleRateLimitMessage(
          context.teamName,
          msg.text,
          observedAt,
          new Date(msg.timestamp)
        );
      }
    }
  }

  checkApiErrorMessages(
    messages: readonly TeamNotificationMessage[],
    context: TeamMessageNotificationContext
  ): void {
    for (const msg of messages) {
      if (msg.from === 'user') continue;
      if (!this.#isApiError(msg.text)) continue;
      if (this.#isRateLimit(msg.text)) continue;

      const rawKey = msg.messageId ?? `${msg.from}:${msg.timestamp}`;
      const dedupeKey = `api-error:${context.teamName}:${rawKey}`;

      if (this.#seenApiErrorKeys.has(dedupeKey)) continue;
      this.#seenApiErrorKeys.add(dedupeKey);
      evictOldestIfNeeded(this.#seenApiErrorKeys, SEEN_API_ERROR_KEYS_MAX);

      const statusMatch = /^API Error:\s*(\d{3})/.exec(msg.text);
      const statusCode = statusMatch?.[1] ?? '???';

      void this.#notificationSink
        .addTeamNotification({
          teamEventType: 'api_error',
          teamName: context.teamName,
          teamDisplayName: context.teamDisplayName,
          from: msg.from,
          summary: `API Error ${statusCode}`,
          body: 'Manual restart needed',
          dedupeKey,
          target: {
            kind: 'member',
            teamName: context.teamName,
            memberName: msg.from,
            focus: 'logs',
          },
          projectPath: context.projectPath,
        })
        .catch(() => undefined);
    }
  }

  scan(messages: readonly TeamNotificationMessage[], context: TeamMessageNotificationContext): void {
    if (messages.length === 0) {
      return;
    }

    this.checkRateLimitMessages(messages, context);
    this.checkApiErrorMessages(messages, context);
  }
}

export const teamMessageNotificationScanner = new TeamMessageNotificationScanner();
