import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildLeadToolApprovalRequest,
  type ToolApprovalNotificationSettingsSnapshot,
} from '../TeamProvisioningToolApprovalFlow';
import {
  type TeamProvisioningToolApprovalNotification,
  type TeamProvisioningToolApprovalNotificationConstructor,
  type TeamProvisioningToolApprovalNotificationOptions,
  TeamProvisioningToolApprovalNotifications,
  type TeamProvisioningToolApprovalNotificationsPorts,
  type TeamProvisioningToolApprovalNotificationWindow,
} from '../TeamProvisioningToolApprovalNotifications';

import type { ToolApprovalRequest } from '@shared/types';

class FakeNotification implements TeamProvisioningToolApprovalNotification {
  static readonly instances: FakeNotification[] = [];

  static isSupported(): boolean {
    return true;
  }

  readonly clickListeners: Array<() => void> = [];
  readonly closeListeners: Array<() => void> = [];
  readonly actionListeners: Array<(event: unknown, index: number) => void> = [];
  shown = false;

  constructor(readonly options: TeamProvisioningToolApprovalNotificationOptions) {
    FakeNotification.instances.push(this);
  }

  on(event: 'click' | 'close', listener: () => void): this;
  on(event: 'action', listener: (event: unknown, index: number) => void): this;
  on(
    event: 'click' | 'close' | 'action',
    listener: (() => void) | ((event: unknown, index: number) => void)
  ): this {
    if (event === 'click') {
      this.clickListeners.push(listener as () => void);
    } else if (event === 'close') {
      this.closeListeners.push(listener as () => void);
    } else {
      this.actionListeners.push(listener as (event: unknown, index: number) => void);
    }
    return this;
  }

  show(): void {
    this.shown = true;
  }

  close(): void {
    this.emitClose();
  }

  emitClick(): void {
    for (const listener of this.clickListeners) listener();
  }

  emitClose(): void {
    for (const listener of this.closeListeners) listener();
  }

  emitAction(index: number): void {
    for (const listener of this.actionListeners) listener(undefined, index);
  }
}

describe('TeamProvisioningToolApprovalNotifications', () => {
  beforeEach(() => {
    FakeNotification.instances.length = 0;
  });

  it('does not create a notification when the main window is focused', () => {
    const { helper, ports } = createHarness({
      mainWindow: windowLike({ focused: true }),
    });

    helper.maybeShow(runLike(), approvalLike());

    expect(ports.getNotificationConstructor).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it.each([
    ['disabled', { enabled: false, notifyOnToolApproval: true, soundEnabled: true }],
    ['notify disabled', { enabled: true, notifyOnToolApproval: false, soundEnabled: true }],
    [
      'snoozed',
      {
        enabled: true,
        notifyOnToolApproval: true,
        soundEnabled: true,
        snoozedUntil: 2_000,
      },
    ],
  ])('does not create a notification when notifications are %s', (_label, notifications) => {
    const { helper, ports } = createHarness({ notifications, nowMs: 1_000 });

    helper.maybeShow(runLike(), approvalLike());

    expect(ports.getNotificationConstructor).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('creates a notification with action buttons and tracks it by requestId', () => {
    const activeApprovalNotifications = new Map<string, TeamProvisioningToolApprovalNotification>();
    const { helper, ports } = createHarness({ activeApprovalNotifications });
    const approval = approvalLike();

    helper.maybeShow(runLike(), approval);

    const notification = notificationAt(0);
    expect(ports.getAppIconPath).toHaveBeenCalled();
    expect(notification.options).toEqual({
      title: 'Tool Approval — Alpha Display',
      body: 'Bash: pnpm test',
      sound: 'default',
      icon: '/app/icon.png',
      actions: [
        { type: 'button', text: 'Allow' },
        { type: 'button', text: 'Deny' },
      ],
    });
    expect(notification.shown).toBe(true);
    expect(activeApprovalNotifications.get(approval.requestId)).toBe(notification);
  });

  it('cleans up on click and shows/focuses the current main window', () => {
    const activeApprovalNotifications = new Map<string, TeamProvisioningToolApprovalNotification>();
    const initialWindow = windowLike();
    const currentWindow = windowLike();
    const { helper, setMainWindow } = createHarness({
      activeApprovalNotifications,
      mainWindow: initialWindow,
    });
    const approval = approvalLike();

    helper.maybeShow(runLike(), approval);
    setMainWindow(currentWindow);
    notificationAt(0).emitClick();

    expect(activeApprovalNotifications.has(approval.requestId)).toBe(false);
    expect(initialWindow.show).not.toHaveBeenCalled();
    expect(initialWindow.focus).not.toHaveBeenCalled();
    expect(currentWindow.show).toHaveBeenCalled();
    expect(currentWindow.focus).toHaveBeenCalled();
  });

  it('responds to action buttons with the existing allow and deny message semantics', () => {
    const respondToToolApproval = vi.fn(async () => undefined);
    const activeApprovalNotifications = new Map<string, TeamProvisioningToolApprovalNotification>();
    const { helper, ports } = createHarness({ activeApprovalNotifications, respondToToolApproval });
    const allowApproval = approvalLike({ requestId: 'req-allow' });
    const denyApproval = approvalLike({ requestId: 'req-deny' });

    helper.maybeShow(runLike(), allowApproval);
    notificationAt(0).emitAction(0);

    helper.maybeShow(runLike(), denyApproval);
    notificationAt(1).emitAction(1);

    expect(respondToToolApproval).toHaveBeenNthCalledWith(
      1,
      'alpha',
      'run-1',
      'req-allow',
      true,
      undefined
    );
    expect(respondToToolApproval).toHaveBeenNthCalledWith(
      2,
      'alpha',
      'run-1',
      'req-deny',
      false,
      'Denied via notification'
    );
    expect(activeApprovalNotifications.size).toBe(0);
    expect(ports.logger.info).toHaveBeenCalledWith(
      '[alpha] Tool approval allowed via OS notification'
    );
    expect(ports.logger.info).toHaveBeenCalledWith(
      '[alpha] Tool approval denied via OS notification'
    );
  });

  it('cleans up the tracked notification when it closes', () => {
    const activeApprovalNotifications = new Map<string, TeamProvisioningToolApprovalNotification>();
    const { helper } = createHarness({ activeApprovalNotifications });
    const approval = approvalLike();

    helper.maybeShow(runLike(), approval);
    notificationAt(0).emitClose();

    expect(activeApprovalNotifications.has(approval.requestId)).toBe(false);
  });
});

function createHarness(
  overrides: {
    activeApprovalNotifications?: Map<string, TeamProvisioningToolApprovalNotification>;
    mainWindow?: TeamProvisioningToolApprovalNotificationWindow | null;
    notifications?: ToolApprovalNotificationSettingsSnapshot;
    nowMs?: number;
    respondToToolApproval?: TeamProvisioningToolApprovalNotificationsPorts['respondToToolApproval'];
  } = {}
): {
  helper: TeamProvisioningToolApprovalNotifications<ReturnType<typeof runLike>>;
  ports: TeamProvisioningToolApprovalNotificationsPorts;
  setMainWindow: (window: TeamProvisioningToolApprovalNotificationWindow | null) => void;
} {
  let mainWindow: TeamProvisioningToolApprovalNotificationWindow | null =
    overrides.mainWindow ?? windowLike();
  const setMainWindow = (window: TeamProvisioningToolApprovalNotificationWindow | null): void => {
    mainWindow = window;
  };
  const ports: TeamProvisioningToolApprovalNotificationsPorts = {
    getMainWindow: vi.fn(() => mainWindow),
    getNotificationSettings: vi.fn(
      () =>
        overrides.notifications ?? {
          enabled: true,
          notifyOnToolApproval: true,
          soundEnabled: true,
        }
    ),
    getNotificationConstructor: vi.fn(
      () => FakeNotification as unknown as TeamProvisioningToolApprovalNotificationConstructor
    ),
    getAppIconPath: vi.fn(() => '/app/icon.png'),
    platform: 'win32',
    activeApprovalNotifications:
      overrides.activeApprovalNotifications ??
      new Map<string, TeamProvisioningToolApprovalNotification>(),
    respondToToolApproval: overrides.respondToToolApproval ?? vi.fn(async () => undefined),
    logger: {
      info: vi.fn(),
      error: vi.fn(),
    },
    nowMs: vi.fn(() => overrides.nowMs ?? 1_000),
  };
  return {
    helper: new TeamProvisioningToolApprovalNotifications(ports),
    ports,
    setMainWindow,
  };
}

function approvalLike(overrides: Partial<ToolApprovalRequest> = {}): ToolApprovalRequest {
  return buildLeadToolApprovalRequest({
    requestId: 'req-1',
    runId: 'run-1',
    teamName: 'alpha',
    toolName: 'Bash',
    toolInput: { command: 'pnpm test' },
    receivedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

function runLike(): { request: { displayName: string } } {
  return {
    request: {
      displayName: 'Alpha Display',
    },
  };
}

function windowLike(
  options: { destroyed?: boolean; focused?: boolean } = {}
): TeamProvisioningToolApprovalNotificationWindow {
  return {
    isDestroyed: vi.fn(() => options.destroyed ?? false),
    isFocused: vi.fn(() => options.focused ?? false),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

function notificationAt(index: number): FakeNotification {
  const notification = FakeNotification.instances[index];
  if (!notification) {
    throw new Error(`Expected fake notification at index ${index}`);
  }
  return notification;
}
