/**
 * NotificationsSection - Notification settings including triggers and ignored repositories.
 */

import { useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import {
  RepositoryDropdown,
  SelectedRepositoryItem,
} from '@renderer/components/common/RepositoryDropdown';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import {
  AlertTriangle,
  ArrowRightLeft,
  Bell,
  BellRing,
  CheckCircle2,
  CirclePlus,
  Clock,
  ExternalLink,
  EyeOff,
  GitBranch,
  HelpCircle,
  Inbox,
  Info,
  Mail,
  MessageSquare,
  PartyPopper,
  Rocket,
  Send,
  ShieldQuestion,
  Users,
  Volume2,
} from 'lucide-react';

import { SettingRow, SettingsSectionHeader, SettingsSelect, SettingsToggle } from '../components';
import { NotificationTriggerSettings } from '../NotificationTriggerSettings';

import type { RepositoryDropdownItem, SafeConfig } from '../hooks/useSettingsConfig';
import type { NotificationTrigger } from '@renderer/types/data';
import type { TeamReviewState, TeamTaskStatus } from '@shared/types';

/** Notification targets span workflow status plus the explicit review axis. */
type NotifiableStatus =
  | TeamTaskStatus
  | Extract<TeamReviewState, 'review' | 'needsFix' | 'approved'>;

const SNOOZE_OPTIONS = [
  { value: 15, labelKey: 'notifications.snooze.options.15' },
  { value: 30, labelKey: 'notifications.snooze.options.30' },
  { value: 60, labelKey: 'notifications.snooze.options.60' },
  { value: 120, labelKey: 'notifications.snooze.options.120' },
  { value: 240, labelKey: 'notifications.snooze.options.240' },
  { value: -1, labelKey: 'notifications.snooze.options.-1' },
] as const;

const STATUS_OPTIONS = [
  {
    value: 'in_progress',
    labelKey: 'notifications.team.statusChange.statuses.options.in_progress',
  },
  { value: 'completed', labelKey: 'notifications.team.statusChange.statuses.options.completed' },
  { value: 'review', labelKey: 'notifications.team.statusChange.statuses.options.review' },
  { value: 'needsFix', labelKey: 'notifications.team.statusChange.statuses.options.needsFix' },
  { value: 'approved', labelKey: 'notifications.team.statusChange.statuses.options.approved' },
  { value: 'pending', labelKey: 'notifications.team.statusChange.statuses.options.pending' },
  { value: 'deleted', labelKey: 'notifications.team.statusChange.statuses.options.deleted' },
] as const satisfies readonly { value: NotifiableStatus; labelKey: string }[];

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
      | 'notifyOnTaskCreated'
      | 'notifyOnAllTasksCompleted'
      | 'notifyOnCrossTeamMessage'
      | 'notifyOnTeamLaunched'
      | 'notifyOnToolApproval'
      | 'notifyOnUsageBudgetAlerts'
      | 'notifyOnUsageBudgetWarning'
      | 'notifyOnUsageBudgetCritical'
      | 'notifyOnUsageBudgetNativeToast'
      | 'autoResumeOnRateLimit'
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
  const { t } = useAppTranslation('settings');
  const [testStatus, setTestStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [testError, setTestError] = useState<string | null>(null);
  const snoozeOptions = useMemo(
    () =>
      SNOOZE_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey),
      })),
    [t]
  );

  const handleTestNotification = async (): Promise<void> => {
    setTestStatus('sending');
    setTestError(null);
    try {
      const result = await api.notifications.testNotification();
      if (result.success) {
        setTestStatus('success');
        setTimeout(() => setTestStatus('idle'), 3000);
      } else {
        setTestStatus('error');
        setTestError(result.error ?? t('notifications.test.unknownError'));
        setTimeout(() => setTestStatus('idle'), 5000);
      }
    } catch (err) {
      console.error('[notifications] testNotification failed:', err);
      setTestStatus('error');
      const message = err instanceof Error ? err.message : t('notifications.test.failedToSend');
      setTestError(message);
      setTimeout(() => setTestStatus('idle'), 5000);
    }
  };

  const isDev = import.meta.env.DEV;

  return (
    <div>
      {/* Dev-mode warning */}
      {isDev ? (
        <div
          className="mb-4 flex items-start gap-2.5 rounded-lg border p-3"
          style={{
            borderColor: 'rgba(234, 179, 8, 0.2)',
            backgroundColor: 'rgba(234, 179, 8, 0.05)',
          }}
        >
          <Info className="mt-0.5 size-4 shrink-0 text-yellow-500" />
          <div>
            <div className="text-sm font-medium text-yellow-500">
              {t('notifications.dev.title')}
            </div>
            <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {t('notifications.dev.descriptionPrefix')}{' '}
              <code className="text-xs">com.github.Electron</code>{' '}
              {t('notifications.dev.descriptionSuffix')}
            </div>
          </div>
        </div>
      ) : null}

      {/* Notification Settings */}
      <SettingsSectionHeader
        title={t('notifications.settings.title')}
        icon={<Bell className="size-3.5" />}
      />
      <SettingRow
        label={t('notifications.settings.enabled.label')}
        description={t('notifications.settings.enabled.description')}
        icon={<BellRing className="size-4" />}
      >
        <SettingsToggle
          enabled={safeConfig.notifications.enabled}
          onChange={(v) => onNotificationToggle('enabled', v)}
          disabled={saving}
        />
      </SettingRow>
      <SettingRow
        label={t('notifications.settings.sound.label')}
        description={t('notifications.settings.sound.description')}
        icon={<Volume2 className="size-4" />}
      >
        <SettingsToggle
          enabled={safeConfig.notifications.soundEnabled}
          onChange={(v) => onNotificationToggle('soundEnabled', v)}
          disabled={saving || !safeConfig.notifications.enabled}
        />
      </SettingRow>
      <SettingRow
        label={t('notifications.settings.subagentErrors.label')}
        description={t('notifications.settings.subagentErrors.description')}
        icon={<AlertTriangle className="size-4" />}
      >
        <SettingsToggle
          enabled={safeConfig.notifications.includeSubagentErrors}
          onChange={(v) => onNotificationToggle('includeSubagentErrors', v)}
          disabled={saving || !safeConfig.notifications.enabled}
        />
      </SettingRow>
      <SettingRow
        label={t('notifications.test.label')}
        description={t('notifications.test.description')}
        icon={<Send className="size-4" />}
      >
        <div className="flex items-center gap-2">
          {testStatus === 'success' ? (
            <span className="text-xs text-green-400">{t('notifications.test.sent')}</span>
          ) : testStatus === 'error' ? (
            <span className="max-w-48 truncate text-xs text-red-400">{testError}</span>
          ) : null}
          <button
            onClick={handleTestNotification}
            disabled={saving || !safeConfig.notifications.enabled || testStatus === 'sending'}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors hover:brightness-125 ${
              saving || !safeConfig.notifications.enabled || testStatus === 'sending'
                ? 'cursor-not-allowed opacity-50'
                : ''
            }`}
            style={{
              backgroundColor: 'var(--color-border-emphasis)',
              color: 'var(--color-text)',
            }}
          >
            {testStatus === 'sending'
              ? t('notifications.test.sending')
              : t('notifications.test.action')}
          </button>
        </div>
      </SettingRow>
      <SettingRow
        label={t('notifications.snooze.label')}
        description={
          isSnoozed
            ? t('notifications.snooze.descriptionWithTime', {
                time: new Date(safeConfig.notifications.snoozedUntil!).toLocaleTimeString(),
              })
            : t('notifications.snooze.description')
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
              {t('notifications.snooze.clear')}
            </button>
          ) : (
            <SettingsSelect
              value={0}
              options={[
                { value: 0, label: t('notifications.snooze.selectDuration') },
                ...snoozeOptions,
              ]}
              onChange={(v) => v !== 0 && onSnooze(v)}
              disabled={saving || !safeConfig.notifications.enabled}
              dropUp
            />
          )}
        </div>
      </SettingRow>

      <div id="usage-budget-notifications" className="scroll-mt-6">
        <div className="flex items-center justify-between gap-3">
          <SettingsSectionHeader
            title={t('notifications.usageBudgets.title')}
            icon={<Bell className="size-3.5" />}
          />
          <SettingsInfoTooltip
            label={t('notifications.usageBudgets.infoAriaLabel')}
            description={t('notifications.usageBudgets.info')}
          />
        </div>
        <div
          className="mb-4 rounded-lg border p-4"
          style={{
            borderColor: 'var(--color-border)',
            backgroundColor: 'var(--color-surface-raised)',
          }}
        >
          <SettingRow
            label={t('notifications.usageBudgets.enabled.label')}
            description={t('notifications.usageBudgets.enabled.description')}
            icon={<BellRing className="size-4" />}
          >
            <SettingsToggle
              enabled={safeConfig.notifications.notifyOnUsageBudgetAlerts}
              onChange={(v) => onNotificationToggle('notifyOnUsageBudgetAlerts', v)}
              disabled={saving || !safeConfig.notifications.enabled}
            />
          </SettingRow>
          <SettingRow
            label={t('notifications.usageBudgets.warning.label')}
            description={t('notifications.usageBudgets.warning.description')}
            icon={<AlertTriangle className="size-4" />}
          >
            <SettingsToggle
              enabled={safeConfig.notifications.notifyOnUsageBudgetWarning}
              onChange={(v) => onNotificationToggle('notifyOnUsageBudgetWarning', v)}
              disabled={
                saving ||
                !safeConfig.notifications.enabled ||
                !safeConfig.notifications.notifyOnUsageBudgetAlerts
              }
            />
          </SettingRow>
          <SettingRow
            label={t('notifications.usageBudgets.critical.label')}
            description={t('notifications.usageBudgets.critical.description')}
            icon={<AlertTriangle className="size-4" />}
          >
            <SettingsToggle
              enabled={safeConfig.notifications.notifyOnUsageBudgetCritical}
              onChange={(v) => onNotificationToggle('notifyOnUsageBudgetCritical', v)}
              disabled={
                saving ||
                !safeConfig.notifications.enabled ||
                !safeConfig.notifications.notifyOnUsageBudgetAlerts
              }
            />
          </SettingRow>
          <SettingRow
            label={t('notifications.usageBudgets.nativeToast.label')}
            description={t('notifications.usageBudgets.nativeToast.description')}
            icon={<Volume2 className="size-4" />}
          >
            <SettingsToggle
              enabled={safeConfig.notifications.notifyOnUsageBudgetNativeToast}
              onChange={(v) => onNotificationToggle('notifyOnUsageBudgetNativeToast', v)}
              disabled={
                saving ||
                !safeConfig.notifications.enabled ||
                !safeConfig.notifications.notifyOnUsageBudgetAlerts
              }
            />
          </SettingRow>
        </div>
      </div>

      {/* Team Notifications — grouped card */}
      <SettingsSectionHeader
        title={t('notifications.team.title')}
        icon={<Users className="size-3.5" />}
      />
      <div
        className="mb-4 rounded-lg border p-4"
        style={{
          borderColor: 'var(--color-border)',
          backgroundColor: 'var(--color-surface-raised)',
        }}
      >
        <div className="grid grid-cols-1 gap-x-6 xl:grid-cols-2">
          <SettingRow
            label={t('notifications.team.leadInbox.label')}
            description={t('notifications.team.leadInbox.description')}
            icon={<Inbox className="size-4" />}
          >
            <SettingsToggle
              enabled={safeConfig.notifications.notifyOnLeadInbox}
              onChange={(v) => onNotificationToggle('notifyOnLeadInbox', v)}
              disabled={saving || !safeConfig.notifications.enabled}
            />
          </SettingRow>
          <SettingRow
            label={t('notifications.team.userInbox.label')}
            description={t('notifications.team.userInbox.description')}
            icon={<Mail className="size-4" />}
          >
            <SettingsToggle
              enabled={safeConfig.notifications.notifyOnUserInbox}
              onChange={(v) => onNotificationToggle('notifyOnUserInbox', v)}
              disabled={saving || !safeConfig.notifications.enabled}
            />
          </SettingRow>
          <SettingRow
            label={t('notifications.team.clarifications.label')}
            description={t('notifications.team.clarifications.description')}
            icon={<HelpCircle className="size-4" />}
          >
            <SettingsToggle
              enabled={safeConfig.notifications.notifyOnClarifications}
              onChange={(v) => onNotificationToggle('notifyOnClarifications', v)}
              disabled={saving || !safeConfig.notifications.enabled}
            />
          </SettingRow>
          <SettingRow
            label={t('notifications.team.taskComments.label')}
            description={t('notifications.team.taskComments.description')}
            icon={<MessageSquare className="size-4" />}
          >
            <SettingsToggle
              enabled={safeConfig.notifications.notifyOnTaskComments}
              onChange={(v) => onNotificationToggle('notifyOnTaskComments', v)}
              disabled={saving || !safeConfig.notifications.enabled}
            />
          </SettingRow>
          <SettingRow
            label={t('notifications.team.taskCreated.label')}
            description={t('notifications.team.taskCreated.description')}
            icon={<CirclePlus className="size-4" />}
          >
            <SettingsToggle
              enabled={safeConfig.notifications.notifyOnTaskCreated}
              onChange={(v) => onNotificationToggle('notifyOnTaskCreated', v)}
              disabled={saving || !safeConfig.notifications.enabled}
            />
          </SettingRow>
          <SettingRow
            label={t('notifications.team.allTasksCompleted.label')}
            description={t('notifications.team.allTasksCompleted.description')}
            icon={<CheckCircle2 className="size-4" />}
          >
            <SettingsToggle
              enabled={safeConfig.notifications.notifyOnAllTasksCompleted}
              onChange={(v) => onNotificationToggle('notifyOnAllTasksCompleted', v)}
              disabled={saving || !safeConfig.notifications.enabled}
            />
          </SettingRow>
          <SettingRow
            label={t('notifications.team.crossTeamMessage.label')}
            description={t('notifications.team.crossTeamMessage.description')}
            icon={<GitBranch className="size-4" />}
          >
            <SettingsToggle
              enabled={safeConfig.notifications.notifyOnCrossTeamMessage}
              onChange={(v) => onNotificationToggle('notifyOnCrossTeamMessage', v)}
              disabled={saving || !safeConfig.notifications.enabled}
            />
          </SettingRow>
          <SettingRow
            label={t('notifications.team.teamLaunched.label')}
            description={t('notifications.team.teamLaunched.description')}
            icon={<Rocket className="size-4" />}
          >
            <SettingsToggle
              enabled={safeConfig.notifications.notifyOnTeamLaunched}
              onChange={(v) => onNotificationToggle('notifyOnTeamLaunched', v)}
              disabled={saving || !safeConfig.notifications.enabled}
            />
          </SettingRow>
          <SettingRow
            label={t('notifications.team.toolApproval.label')}
            description={t('notifications.team.toolApproval.description')}
            icon={<ShieldQuestion className="size-4" />}
          >
            <SettingsToggle
              enabled={safeConfig.notifications.notifyOnToolApproval}
              onChange={(v) => onNotificationToggle('notifyOnToolApproval', v)}
              disabled={saving || !safeConfig.notifications.enabled}
            />
          </SettingRow>
          <SettingRow
            label={t('notifications.team.autoResumeOnRateLimit.label')}
            description={t('notifications.team.autoResumeOnRateLimit.description')}
            icon={<Clock className="size-4" />}
          >
            <SettingsToggle
              enabled={safeConfig.notifications.autoResumeOnRateLimit}
              onChange={(v) => onNotificationToggle('autoResumeOnRateLimit', v)}
              disabled={saving || !safeConfig.notifications.enabled}
            />
          </SettingRow>

          {/* Task Status Change Notifications — nested within team card */}
          <div className="*:last:border-b-0 xl:col-span-2">
            <SettingRow
              label={t('notifications.team.statusChange.label')}
              description={t('notifications.team.statusChange.description')}
              icon={<ArrowRightLeft className="size-4" />}
            >
              <SettingsToggle
                enabled={safeConfig.notifications.notifyOnStatusChange}
                onChange={(v) => onNotificationToggle('notifyOnStatusChange', v)}
                disabled={saving || !safeConfig.notifications.enabled}
              />
            </SettingRow>
            {safeConfig.notifications.notifyOnStatusChange && safeConfig.notifications.enabled ? (
              <div
                className="flex flex-col gap-3 border-b pb-3"
                style={{ borderColor: 'var(--color-border-subtle)', paddingLeft: 30 }}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div
                      className="text-sm font-medium"
                      style={{ color: 'var(--color-text-secondary)' }}
                    >
                      {t('notifications.team.statusChange.onlySolo.label')}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      {t('notifications.team.statusChange.onlySolo.description')}
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
                <div className="flex flex-col gap-1.5">
                  <div>
                    <div
                      className="text-sm font-medium"
                      style={{ color: 'var(--color-text-secondary)' }}
                    >
                      {t('notifications.team.statusChange.statuses.label')}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      {t('notifications.team.statusChange.statuses.description')}
                    </div>
                  </div>
                  <StatusCheckboxGroup
                    selected={safeConfig.notifications.statusChangeStatuses}
                    onChange={onStatusChangeStatusesUpdate}
                    disabled={saving}
                    t={t}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Custom Triggers */}
      <NotificationTriggerSettings
        triggers={safeConfig.notifications.triggers || []}
        saving={saving}
        onUpdateTrigger={onUpdateTrigger}
        onAddTrigger={onAddTrigger}
        onRemoveTrigger={onRemoveTrigger}
      />

      <SettingsSectionHeader
        title={t('notifications.ignoredRepositories.title')}
        icon={<EyeOff className="size-3.5" />}
      />
      <p className="mb-3 text-xs" style={{ color: 'var(--color-text-muted)' }}>
        {t('notifications.ignoredRepositories.description')}
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
            {t('notifications.ignoredRepositories.empty')}
          </p>
        </div>
      )}
      <RepositoryDropdown
        onSelect={onAddIgnoredRepository}
        excludeIds={excludedRepositoryIds}
        placeholder={t('notifications.ignoredRepositories.selectPlaceholder')}
        disabled={saving}
        dropUp
      />

      {/* Task Completion Notifications */}
      <SettingsSectionHeader
        title={t('notifications.taskCompletion.title')}
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
          {t('notifications.taskCompletion.description')}
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
          {t('notifications.taskCompletion.installPlugin')}
        </button>
      </div>
    </div>
  );
};

const StatusCheckboxGroup = ({
  selected,
  onChange,
  disabled,
  t,
}: {
  selected: string[];
  onChange: (statuses: string[]) => void;
  disabled: boolean;
  t: ReturnType<typeof useAppTranslation>['t'];
}) => (
  <div className="flex flex-wrap gap-2">
    {STATUS_OPTIONS.map((option) => {
      const checked = selected.includes(option.value);
      return (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          onClick={() => {
            const next = checked
              ? selected.filter((selectedStatus) => selectedStatus !== option.value)
              : [...selected, option.value];
            onChange(next);
          }}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            checked
              ? 'bg-indigo-500/20 text-indigo-400'
              : 'bg-[var(--color-surface-raised)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
          } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
        >
          {t(option.labelKey)}
        </button>
      );
    })}
  </div>
);

const SettingsInfoTooltip = ({
  label,
  description,
}: {
  label: string;
  description: string;
}): React.JSX.Element => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        className="mt-6 inline-flex size-6 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-[var(--color-surface-raised)] hover:text-text"
        aria-label={label}
      >
        <Info className="size-3.5" />
      </button>
    </TooltipTrigger>
    <TooltipContent className="max-w-72 text-pretty text-xs leading-relaxed">
      {description}
    </TooltipContent>
  </Tooltip>
);
