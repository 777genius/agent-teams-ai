/**
 * NotificationsSection - Notification settings including triggers and ignored repositories.
 */

import { api } from '@renderer/api';
import {
  RepositoryDropdown,
  SelectedRepositoryItem,
} from '@renderer/components/common/RepositoryDropdown';
import {
  AlertTriangle,
  ArrowRightLeft,
  Bell,
  BellRing,
  Clock,
  ExternalLink,
  EyeOff,
  HelpCircle,
  Inbox,
  Mail,
  MessageSquare,
  PartyPopper,
  Volume2,
} from 'lucide-react';

import { SettingRow, SettingsSectionHeader, SettingsSelect, SettingsToggle } from '../components';
import { NotificationTriggerSettings } from '../NotificationTriggerSettings';

import type { RepositoryDropdownItem, SafeConfig } from '../hooks/useSettingsConfig';
import type { NotificationTrigger } from '@renderer/types/data';
import type { TeamReviewState, TeamTaskStatus } from '@shared/types';

/** Notification targets span workflow status plus the explicit review axis. */
type NotifiableStatus = TeamTaskStatus | Extract<TeamReviewState, 'needsFix' | 'approved'>;

// Snooze duration options
const SNOOZE_OPTIONS = [
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours' },
  { value: 240, label: '4 hours' },
  { value: -1, label: 'Until tomorrow' },
] as const;

interface NotificationsSectionProps {
  readonly safeConfig: SafeConfig;
  readonly saving: boolean;
  readonly isSnoozed: boolean;
  readonly ignoredRepositoryItems: RepositoryDropdownItem[];
  readonly excludedRepositoryIds: string[];
  readonly onNotificationToggle: (
    key:
      | 'enabled'
      | 'soundEnabled'
      | 'includeSubagentErrors'
      | 'notifyOnLeadInbox'
      | 'notifyOnUserInbox'
      | 'notifyOnClarifications'
      | 'notifyOnStatusChange'
      | 'notifyOnTaskComments'
      | 'statusChangeOnlySolo',
    value: boolean
  ) => void;
  readonly onStatusChangeStatusesUpdate: (statuses: string[]) => void;
  readonly onSnooze: (minutes: number) => Promise<void>;
  readonly onClearSnooze: () => Promise<void>;
  readonly onAddIgnoredRepository: (item: RepositoryDropdownItem) => Promise<void>;
  readonly onRemoveIgnoredRepository: (repositoryId: string) => Promise<void>;
  readonly onAddTrigger: (trigger: Omit<NotificationTrigger, 'isBuiltin'>) => Promise<void>;
  readonly onUpdateTrigger: (
    triggerId: string,
    updates: Partial<NotificationTrigger>
  ) => Promise<void>;
  readonly onRemoveTrigger: (triggerId: string) => Promise<void>;
}

export const NotificationsSection = ({
  safeConfig,
  saving,
  isSnoozed,
  ignoredRepositoryItems,
  excludedRepositoryIds,
  onNotificationToggle,
  onSnooze,
  onClearSnooze,
  onAddIgnoredRepository,
  onRemoveIgnoredRepository,
  onAddTrigger,
  onUpdateTrigger,
  onRemoveTrigger,
  onStatusChangeStatusesUpdate,
}: NotificationsSectionProps): React.JSX.Element => {
  return (
    <div>
      {/* Task Completion Notifications */}
      <SettingsSectionHeader
        title="Task Completion Notifications"
        icon={<PartyPopper className="size-3.5" />}
      />
      <div
        className="mb-4 rounded-lg border p-4"
        style={{
          borderColor: 'var(--color-border)',
          backgroundColor: 'var(--color-surface-raised)',
        }}
      >
        <p className="mb-3 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          Get native OS notifications when Claude finishes tasks — sounds, banners, and Dock/taskbar
          badges. Works on macOS, Linux, and Windows.
        </p>
        <button
          onClick={() =>
            void api.openExternal('https://github.com/777genius/claude-notifications-go')
          }
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors hover:brightness-125"
          style={{
            backgroundColor: 'var(--color-border-emphasis)',
            color: 'var(--color-text)',
          }}
        >
          <ExternalLink className="size-3.5" />
          Install claude-notifications-go plugin
        </button>
      </div>

      {/* Notification Settings */}
      <SettingsSectionHeader title="Notification Settings" icon={<Bell className="size-3.5" />} />
      <SettingRow
        label="Enable System Notifications"
        description="Show system notifications for errors and events"
        icon={<BellRing className="size-4" />}
      >
        <SettingsToggle
          enabled={safeConfig.notifications.enabled}
          onChange={(v) => onNotificationToggle('enabled', v)}
          disabled={saving}
        />
      </SettingRow>
      <SettingRow
        label="Play sound"
        description="Play a sound when notifications appear"
        icon={<Volume2 className="size-4" />}
      >
        <SettingsToggle
          enabled={safeConfig.notifications.soundEnabled}
          onChange={(v) => onNotificationToggle('soundEnabled', v)}
          disabled={saving || !safeConfig.notifications.enabled}
        />
      </SettingRow>
      <SettingRow
        label="Include subagent errors"
        description="Detect and notify about errors in subagent sessions"
        icon={<AlertTriangle className="size-4" />}
      >
        <SettingsToggle
          enabled={safeConfig.notifications.includeSubagentErrors}
          onChange={(v) => onNotificationToggle('includeSubagentErrors', v)}
          disabled={saving || !safeConfig.notifications.enabled}
        />
      </SettingRow>
      <SettingRow
        label="Lead inbox notifications"
        description="Notify when teammates send messages to the team lead"
        icon={<Inbox className="size-4" />}
      >
        <SettingsToggle
          enabled={safeConfig.notifications.notifyOnLeadInbox}
          onChange={(v) => onNotificationToggle('notifyOnLeadInbox', v)}
          disabled={saving || !safeConfig.notifications.enabled}
        />
      </SettingRow>
      <SettingRow
        label="User inbox notifications"
        description="Notify when teammates send messages to you"
        icon={<Mail className="size-4" />}
      >
        <SettingsToggle
          enabled={safeConfig.notifications.notifyOnUserInbox}
          onChange={(v) => onNotificationToggle('notifyOnUserInbox', v)}
          disabled={saving || !safeConfig.notifications.enabled}
        />
      </SettingRow>
      <SettingRow
        label="Task clarification notifications"
        description="Show native OS notifications when a task needs your input"
        icon={<HelpCircle className="size-4" />}
      >
        <SettingsToggle
          enabled={safeConfig.notifications.notifyOnClarifications}
          onChange={(v) => onNotificationToggle('notifyOnClarifications', v)}
          disabled={saving || !safeConfig.notifications.enabled}
        />
      </SettingRow>
      <SettingRow
        label="Task comment notifications"
        description="Show native OS notifications when agents comment on tasks"
        icon={<MessageSquare className="size-4" />}
      >
        <SettingsToggle
          enabled={safeConfig.notifications.notifyOnTaskComments}
          onChange={(v) => onNotificationToggle('notifyOnTaskComments', v)}
          disabled={saving || !safeConfig.notifications.enabled}
        />
      </SettingRow>
      <SettingRow
        label="Snooze notifications"
        description={
          isSnoozed
            ? `Snoozed until ${new Date(safeConfig.notifications.snoozedUntil!).toLocaleTimeString()}`
            : 'Temporarily pause notifications'
        }
        icon={<Clock className="size-4" />}
      >
        <div className="flex items-center gap-2">
          {isSnoozed ? (
            <button
              onClick={onClearSnooze}
              disabled={saving}
              className={`rounded-md bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-400 transition-all duration-150 hover:bg-red-500/20 ${saving ? 'cursor-not-allowed opacity-50' : ''} `}
            >
              Clear Snooze
            </button>
          ) : (
            <SettingsSelect
              value={0}
              options={[{ value: 0, label: 'Select duration...' }, ...SNOOZE_OPTIONS]}
              onChange={(v) => v !== 0 && onSnooze(v)}
              disabled={saving || !safeConfig.notifications.enabled}
              dropUp
            />
          )}
        </div>
      </SettingRow>

      {/* Task Status Change Notifications — grouped section */}
      <div className="border-b py-3" style={{ borderColor: 'var(--color-border-subtle)' }}>
        <div className="flex items-center justify-between">
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 shrink-0" style={{ color: 'var(--color-text-muted)' }}>
              <ArrowRightLeft className="size-4" />
            </div>
            <div>
              <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                Task status change notifications
              </div>
              <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Show native OS notifications when a task&apos;s status changes
              </div>
            </div>
          </div>
          <div className="shrink-0">
            <SettingsToggle
              enabled={safeConfig.notifications.notifyOnStatusChange}
              onChange={(v) => onNotificationToggle('notifyOnStatusChange', v)}
              disabled={saving || !safeConfig.notifications.enabled}
            />
          </div>
        </div>
        {safeConfig.notifications.notifyOnStatusChange && safeConfig.notifications.enabled ? (
          <div
            className="mt-3 flex flex-col gap-3 border-t pt-3"
            style={{ borderColor: 'var(--color-border-subtle)', paddingLeft: 15 }}
          >
            <div className="flex items-center justify-between">
              <div>
                <div
                  className="text-sm font-medium"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  Only in Solo mode
                </div>
                <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  Notify only when the team has no teammates
                </div>
              </div>
              <div className="shrink-0">
                <SettingsToggle
                  enabled={safeConfig.notifications.statusChangeOnlySolo}
                  onChange={(v) => onNotificationToggle('statusChangeOnlySolo', v)}
                  disabled={saving}
                />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div
                  className="text-sm font-medium"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  Notify on these statuses
                </div>
                <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  Which target statuses trigger a notification
                </div>
              </div>
              <div className="shrink-0">
                <StatusCheckboxGroup
                  selected={safeConfig.notifications.statusChangeStatuses}
                  onChange={onStatusChangeStatusesUpdate}
                  disabled={saving}
                />
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Custom Triggers */}
      <NotificationTriggerSettings
        triggers={safeConfig.notifications.triggers || []}
        saving={saving}
        onUpdateTrigger={onUpdateTrigger}
        onAddTrigger={onAddTrigger}
        onRemoveTrigger={onRemoveTrigger}
      />

      <SettingsSectionHeader title="Ignored Repositories" icon={<EyeOff className="size-3.5" />} />
      <p className="mb-3 text-xs" style={{ color: 'var(--color-text-muted)' }}>
        Notifications from these repositories will be ignored
      </p>
      {ignoredRepositoryItems.length > 0 ? (
        <div className="mb-3">
          {ignoredRepositoryItems.map((item) => (
            <SelectedRepositoryItem
              key={item.id}
              item={item}
              onRemove={() => onRemoveIgnoredRepository(item.id)}
              disabled={saving}
            />
          ))}
        </div>
      ) : (
        <div
          className="mb-3 rounded-md border border-dashed py-3 text-center"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            No repositories ignored
          </p>
        </div>
      )}
      <RepositoryDropdown
        onSelect={onAddIgnoredRepository}
        excludeIds={excludedRepositoryIds}
        placeholder="Select repository to ignore..."
        disabled={saving}
        dropUp
      />
    </div>
  );
};

const STATUS_OPTIONS: { value: NotifiableStatus; label: string }[] = [
  { value: 'in_progress', label: 'Started' },
  { value: 'completed', label: 'Completed' },
  { value: 'needsFix', label: 'Needs Fixes' },
  { value: 'approved', label: 'Approved' },
  { value: 'pending', label: 'Pending' },
  { value: 'deleted', label: 'Deleted' },
];

const StatusCheckboxGroup = ({
  selected,
  onChange,
  disabled,
}: {
  selected: string[];
  onChange: (statuses: string[]) => void;
  disabled: boolean;
}) => (
  <div className="flex flex-wrap gap-2">
    {STATUS_OPTIONS.map((opt) => {
      const checked = selected.includes(opt.value);
      return (
        <button
          key={opt.value}
          type="button"
          disabled={disabled}
          onClick={() => {
            const next = checked
              ? selected.filter((s) => s !== opt.value)
              : [...selected, opt.value];
            onChange(next);
          }}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            checked
              ? 'bg-indigo-500/20 text-indigo-400'
              : 'bg-[var(--color-surface-raised)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
          } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
        >
          {opt.label}
        </button>
      );
    })}
  </div>
);
