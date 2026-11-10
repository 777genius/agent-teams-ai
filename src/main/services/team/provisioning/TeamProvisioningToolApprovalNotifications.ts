import {
  planToolApprovalNotification,
  type ToolApprovalNotificationSettingsSnapshot,
} from './TeamProvisioningToolApprovalFlow';

import type { ToolApprovalRequest } from '@shared/types';

export interface TeamProvisioningToolApprovalNotificationWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  show(): void;
  focus(): void;
}

export interface TeamProvisioningToolApprovalNotification {
  on(event: 'click' | 'close', listener: () => void): this;
  on(event: 'action', listener: (event: unknown, index: number) => void): this;
  show(): void;
  close(): void;
}

export interface TeamProvisioningToolApprovalNotificationOptions {
  title: string;
  body: string;
  sound?: 'default';
  icon?: string;
  actions?: Array<{ type: 'button'; text: string }>;
}

export interface TeamProvisioningToolApprovalNotificationConstructor {
  new (
    options: TeamProvisioningToolApprovalNotificationOptions
  ): TeamProvisioningToolApprovalNotification;
  isSupported?: () => boolean;
}

export interface TeamProvisioningToolApprovalNotificationRunLike {
  request: {
    displayName?: string;
  };
}

export interface TeamProvisioningToolApprovalNotificationsPorts {
  getMainWindow: () => TeamProvisioningToolApprovalNotificationWindow | null;
  getNotificationSettings: () => ToolApprovalNotificationSettingsSnapshot;
  getNotificationConstructor: () => TeamProvisioningToolApprovalNotificationConstructor | null;
  getAppIconPath: () => string | undefined;
  platform: NodeJS.Platform;
  activeApprovalNotifications: Map<string, TeamProvisioningToolApprovalNotification>;
  respondToToolApproval: (
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ) => Promise<void>;
  logger: {
    info: (message: string) => void;
    error: (message: string) => void;
  };
  nowMs: () => number;
}

export class TeamProvisioningToolApprovalNotifications<
  Run extends TeamProvisioningToolApprovalNotificationRunLike,
> {
  constructor(private readonly ports: TeamProvisioningToolApprovalNotificationsPorts) {}

  maybeShow(run: Run | undefined, approval: ToolApprovalRequest): void {
    const win = this.ports.getMainWindow();
    const isWindowFocused = Boolean(win && !win.isDestroyed() && win.isFocused());
    if (isWindowFocused) return;

    const notifications = this.ports.getNotificationSettings();
    if (!notifications.enabled || !notifications.notifyOnToolApproval) return;

    const nowMs = this.ports.nowMs();
    const snoozedUntil = notifications.snoozedUntil;
    if (snoozedUntil && nowMs < snoozedUntil) return;

    const NotificationConstructor = this.ports.getNotificationConstructor();
    const isMac = this.ports.platform === 'darwin';
    const iconPath = isMac ? undefined : this.ports.getAppIconPath();
    const plan = planToolApprovalNotification({
      approval,
      notifications,
      isWindowFocused,
      isNotificationSupported: Boolean(NotificationConstructor?.isSupported?.()),
      platform: this.ports.platform,
      iconPath,
      teamLabel: approval.teamDisplayName ?? run?.request.displayName ?? approval.teamName,
      nowMs,
    });
    if (!plan || !NotificationConstructor) return;

    const notification = new NotificationConstructor({
      title: plan.title,
      body: plan.body,
      sound: plan.sound,
      ...(plan.icon ? { icon: plan.icon } : {}),
      ...(plan.supportsActions
        ? {
            actions: [
              { type: 'button' as const, text: 'Allow' },
              { type: 'button' as const, text: 'Deny' },
            ],
          }
        : {}),
    });

    this.ports.activeApprovalNotifications.set(approval.requestId, notification);
    const cleanup = (): void => {
      this.ports.activeApprovalNotifications.delete(approval.requestId);
    };

    notification.on('click', () => {
      cleanup();
      const currentWin = this.ports.getMainWindow();
      if (currentWin && !currentWin.isDestroyed()) {
        currentWin.show();
        currentWin.focus();
      }
    });

    notification.on('close', cleanup);

    if (plan.supportsActions) {
      notification.on('action', (_event, index) => {
        cleanup();
        const allow = index === 0;
        this.ports.logger.info(
          `[${approval.teamName}] Tool approval ${allow ? 'allowed' : 'denied'} via OS notification`
        );
        void this.ports
          .respondToToolApproval(
            approval.teamName,
            approval.runId,
            approval.requestId,
            allow,
            allow ? undefined : 'Denied via notification'
          )
          .catch((err) => {
            this.ports.logger.error(
              `[${approval.teamName}] Failed to respond via notification: ${err instanceof Error ? err.message : String(err)}`
            );
          });
      });
    }

    notification.show();
  }
}
