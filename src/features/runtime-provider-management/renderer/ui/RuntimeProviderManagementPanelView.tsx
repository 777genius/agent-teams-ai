import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs';
import { cn } from '@renderer/lib/utils';
import {
  compareOpenCodeTeamModelRecommendations,
  getOpenCodeTeamModelRecommendation,
  isOpenCodeTeamModelRecommended,
} from '@renderer/utils/openCodeModelRecommendations';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ClipboardList,
  KeyRound,
  Loader2,
  RefreshCcw,
  Search,
  Star,
  Trash2,
} from 'lucide-react';

import {
  formatProviderState,
  formatRuntimeState,
  getProviderAction,
  getProviderModelsLabel,
} from '../../core/domain';

import { ProviderBrandIcon } from './providerBrandIcons';

import type {
  RuntimeProviderManagementActions,
  RuntimeProviderManagementState,
} from '../hooks/useRuntimeProviderManagement';
import type {
  RuntimeProviderConnectionDto,
  RuntimeProviderDefaultModelSourceDto,
  RuntimeProviderDefaultScopeDto,
  RuntimeProviderDirectoryEntryDto,
  RuntimeProviderManagementErrorDiagnosticsDto,
  RuntimeProviderModelDto,
  RuntimeProviderModelTestResultDto,
  RuntimeProviderSetupPromptDto,
} from '@features/runtime-provider-management/contracts';
import type { ProjectPathProject } from '@renderer/components/team/dialogs/projectPathProjects';
import type { CSSProperties, JSX, KeyboardEvent } from 'react';

interface RuntimeProviderManagementPanelViewProps {
  readonly state: RuntimeProviderManagementState;
  readonly actions: RuntimeProviderManagementActions;
  readonly disabled: boolean;
  readonly projectPath?: string | null;
  readonly projectContextProjects?: readonly ProjectPathProject[];
  readonly projectContextLoading?: boolean;
  readonly projectContextError?: string | null;
  readonly onProjectContextChange?: (projectPath: string | null) => void;
}

interface ProviderActionsProps {
  readonly provider: RuntimeProviderConnectionDto;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onStartConnect: () => void;
  readonly onForget: () => void;
}

interface ProviderRowProps {
  readonly provider: RuntimeProviderConnectionDto;
  readonly state: RuntimeProviderManagementState;
  readonly active: boolean;
  readonly formOpen: boolean;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly hasProjectContext: boolean;
  readonly actions: RuntimeProviderManagementActions;
}

interface RuntimeProviderErrorAlertProps {
  readonly message: string;
  readonly diagnostics?: RuntimeProviderManagementErrorDiagnosticsDto | null;
  readonly testId: string;
}

type OpenCodeSettingsSection = 'models' | 'providers';
type SettingsT = ReturnType<typeof useAppTranslation>['t'];

const NO_PROJECT_CONTEXT_VALUE = '__runtime-provider-no-project-context__';

function getDirectoryAction(
  provider: RuntimeProviderDirectoryEntryDto,
  actionId: RuntimeProviderConnectionDto['actions'][number]['id']
) {
  return provider.actions.find((action) => action.id === actionId) ?? null;
}

function formatDirectorySetupKind(provider: RuntimeProviderDirectoryEntryDto): string {
  if (provider.metadata.configuredAuthless) {
    return 'Configured local';
  }
  switch (provider.setupKind) {
    case 'connected':
      return 'Connected';
    case 'connect-api-key':
      return 'Connect';
    case 'configure-manually':
      return 'Manual setup required';
    case 'requires-environment':
      return 'Requires environment';
    case 'available-readonly':
      return 'Available';
    case 'unsupported':
      return 'Unsupported';
  }
}

function getDirectoryModelsLabel(provider: RuntimeProviderDirectoryEntryDto): string {
  if (provider.modelCount === null) {
    return 'models unknown';
  }
  if (provider.modelCount <= 0) {
    return 'models not reported';
  }
  return `${provider.modelCount} model${provider.modelCount === 1 ? '' : 's'}`;
}

function formatOpenCodeProviderCount(count: number): string {
  return `${count} OpenCode provider${count === 1 ? '' : 's'}`;
}

function getProjectContextName(projectPath: string | null | undefined): string | null {
  const trimmed = projectPath?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/[\\/]+$/, '');
  const name = normalized.split(/[\\/]/).pop()?.trim();
  return name || normalized;
}

function getDefaultScopeDescription(scope: RuntimeProviderDefaultScopeDto, t: SettingsT): string {
  return scope === 'all_projects'
    ? t('runtimeProvider.defaults.scopeDescriptionAllProjects')
    : t('runtimeProvider.defaults.scopeDescriptionProject');
}

function getDefaultScopeButtonLabel(scope: RuntimeProviderDefaultScopeDto, t: SettingsT): string {
  return scope === 'all_projects'
    ? t('runtimeProvider.defaults.setAllProjectsDefault')
    : t('runtimeProvider.defaults.setProjectDefault');
}

function getContextControlLabel(scope: RuntimeProviderDefaultScopeDto, t: SettingsT): string {
  return scope === 'all_projects'
    ? t('runtimeProvider.defaults.validationContext')
    : t('runtimeProvider.defaults.projectOverrideContext');
}

function getContextControlHint(
  scope: RuntimeProviderDefaultScopeDto,
  projectPath: string | null | undefined,
  t: SettingsT
): string {
  const projectName = getProjectContextName(projectPath) ?? projectPath?.trim();
  if (!projectName) {
    return t('runtimeProvider.defaults.selectProjectHint');
  }
  return scope === 'all_projects'
    ? t('runtimeProvider.defaults.allProjectsHint', { project: projectName })
    : t('runtimeProvider.defaults.projectHint', { project: projectName });
}

function getDefaultModelSourceLabel(
  source: RuntimeProviderDefaultModelSourceDto | null | undefined
): string | null {
  switch (source) {
    case 'project':
      return 'project override';
    case 'all_projects':
      return 'all projects';
    case 'opencode_config':
      return 'OpenCode config';
    case 'fallback':
      return 'fallback';
    default:
      return null;
  }
}

function isDefaultForScope(
  model: RuntimeProviderModelDto,
  state: RuntimeProviderManagementState,
  scope: RuntimeProviderDefaultScopeDto
): boolean {
  const scopedDefault =
    scope === 'all_projects'
      ? state.view?.allProjectsDefaultModel
      : state.view?.projectDefaultModel;
  return scopedDefault === model.modelId;
}

function directoryEntryMatchesQuery(
  provider: RuntimeProviderDirectoryEntryDto,
  query: string
): boolean {
  if (!query) {
    return true;
  }
  return [
    provider.providerId,
    provider.displayName,
    provider.detail ?? '',
    provider.defaultModelId ?? '',
    provider.sourceLabel ?? '',
    provider.providerSource ?? '',
    getDirectoryModelsLabel(provider),
    formatDirectorySetupKind(provider),
    ...provider.authMethods,
  ]
    .join(' ')
    .toLowerCase()
    .includes(query);
}

function directorySetupKindClassName(provider: RuntimeProviderDirectoryEntryDto): string {
  if (provider.metadata.configuredAuthless) {
    return 'border-cyan-400/35 bg-cyan-400/10 text-cyan-100';
  }
  switch (provider.setupKind) {
    case 'connected':
      return 'border-emerald-300/70 bg-emerald-600 text-emerald-50';
    case 'connect-api-key':
    case 'available-readonly':
      return 'border-sky-400/30 bg-sky-400/10 text-sky-200';
    case 'configure-manually':
    case 'requires-environment':
      return 'border-white/10 bg-white/[0.04] text-[var(--color-text-muted)]';
    case 'unsupported':
      return 'border-red-400/25 bg-red-400/10 text-red-200';
  }
}

function directoryEntryToProviderConnection(
  provider: RuntimeProviderDirectoryEntryDto
): RuntimeProviderConnectionDto {
  return {
    providerId: provider.providerId,
    displayName: provider.displayName,
    state: provider.state,
    ownership: provider.ownership,
    recommended: provider.recommended,
    modelCount: provider.modelCount ?? 1,
    defaultModelId: provider.defaultModelId,
    authMethods: provider.authMethods,
    actions: provider.actions,
    detail: provider.detail,
  };
}

function stateClassName(provider: RuntimeProviderConnectionDto): string {
  switch (provider.state) {
    case 'connected':
      return 'border-emerald-400/35 bg-emerald-400/10';
    case 'available':
      return 'border-sky-400/25 bg-sky-400/10 text-sky-200';
    case 'error':
      return 'border-red-400/25 bg-red-400/10 text-red-200';
    case 'ignored':
      return 'border-zinc-400/25 bg-zinc-400/10 text-zinc-300';
    case 'not-connected':
      return 'border-white/10 bg-white/[0.04] text-[var(--color-text-muted)]';
  }
}

function stateStyle(provider: RuntimeProviderConnectionDto): CSSProperties | undefined {
  if (provider.state !== 'connected') {
    return undefined;
  }

  return {
    color: '#ecfdf5',
    borderColor: 'rgba(134, 239, 172, 0.72)',
    backgroundColor: '#16a34a',
  };
}

function setupPromptVisible(
  prompt: RuntimeProviderSetupPromptDto,
  values: Readonly<Record<string, string>>
): boolean {
  if (!prompt.when) {
    return true;
  }
  const currentValue = values[prompt.when.key] ?? '';
  switch (prompt.when.op) {
    case 'eq':
      return currentValue === prompt.when.value;
    case 'neq':
    case 'ne':
      return currentValue !== prompt.when.value;
    default:
      return true;
  }
}

function setupFormCanSubmit(state: RuntimeProviderManagementState, providerId: string): boolean {
  const form = state.setupForm?.providerId === providerId ? state.setupForm : null;
  if (!form?.supported) {
    return false;
  }
  if (form.secret?.required && !state.apiKeyValue.trim()) {
    return false;
  }
  return form.prompts
    .filter((prompt) => setupPromptVisible(prompt, state.setupMetadata))
    .every((prompt) => !prompt.required || Boolean(state.setupMetadata[prompt.key]?.trim()));
}

function eventStartedInInteractiveChild(
  currentTarget: HTMLElement,
  target: EventTarget | null
): boolean {
  if (!(target instanceof HTMLElement) || target === currentTarget) {
    return false;
  }
  return Boolean(target.closest('button, input, select, textarea, a, [role="button"], [tabindex]'));
}

function ProviderSetupFormPanel({
  provider,
  state,
  busy,
  disabled,
  actions,
}: {
  readonly provider: RuntimeProviderConnectionDto;
  readonly state: RuntimeProviderManagementState;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly actions: RuntimeProviderManagementActions;
}): JSX.Element {
  const { t } = useAppTranslation('settings');
  const form = state.setupForm?.providerId === provider.providerId ? state.setupForm : null;
  const loading = state.setupFormLoading && state.activeFormProviderId === provider.providerId;
  const error = state.setupFormError;
  const errorDiagnostics = state.setupFormErrorDiagnostics;
  const submitError =
    state.activeFormProviderId === provider.providerId ? state.setupSubmitError : null;
  const submitErrorDiagnostics =
    state.activeFormProviderId === provider.providerId ? state.setupSubmitErrorDiagnostics : null;
  const canSubmit = setupFormCanSubmit(state, provider.providerId);

  return (
    <div
      className="mt-3 rounded-md border p-3"
      style={{ borderColor: 'var(--color-border-subtle)' }}
      onClick={(event) => event.stopPropagation()}
    >
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
          <Loader2 className="size-3.5 animate-spin" />
          {t('runtimeProvider.setup.loading')}
        </div>
      ) : null}

      {!loading && error ? (
        <RuntimeProviderErrorAlert
          message={error}
          diagnostics={errorDiagnostics}
          testId="runtime-provider-setup-form-error"
        />
      ) : null}

      {!loading && form ? (
        <div className="space-y-3">
          <div>
            <div className="text-xs font-medium text-[var(--color-text)]">{form.title}</div>
            {form.description ? (
              <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                {form.description}
              </div>
            ) : null}
          </div>

          {form.secret ? (
            <div className="space-y-1.5">
              <Label htmlFor={`runtime-provider-key-${provider.providerId}`} className="text-xs">
                {form.secret.label}
              </Label>
              <Input
                id={`runtime-provider-key-${provider.providerId}`}
                type="password"
                value={state.apiKeyValue}
                disabled={disabled || busy || !form.supported}
                onChange={(event) => actions.setApiKeyValue(event.target.value)}
                placeholder={form.secret.placeholder ?? 'Paste API key'}
                className="h-9 text-sm"
                autoFocus
              />
            </div>
          ) : null}

          {form.prompts
            .filter((prompt) => setupPromptVisible(prompt, state.setupMetadata))
            .map((prompt) => (
              <div key={prompt.key} className="space-y-1.5">
                <Label
                  htmlFor={`runtime-provider-${provider.providerId}-${prompt.key}`}
                  className="text-xs"
                >
                  {prompt.label}
                </Label>
                {prompt.type === 'select' ? (
                  <Select
                    value={state.setupMetadata[prompt.key] ?? ''}
                    disabled={disabled || busy || !form.supported}
                    onValueChange={(value) => actions.setSetupMetadataValue(prompt.key, value)}
                  >
                    <SelectTrigger
                      id={`runtime-provider-${provider.providerId}-${prompt.key}`}
                      className="h-9 text-sm"
                    >
                      <SelectValue placeholder={prompt.placeholder ?? 'Select value'} />
                    </SelectTrigger>
                    <SelectContent>
                      {prompt.options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={`runtime-provider-${provider.providerId}-${prompt.key}`}
                    type={prompt.secret ? 'password' : 'text'}
                    value={state.setupMetadata[prompt.key] ?? ''}
                    disabled={disabled || busy || !form.supported}
                    onChange={(event) =>
                      actions.setSetupMetadataValue(prompt.key, event.target.value)
                    }
                    placeholder={prompt.placeholder ?? undefined}
                    className="h-9 text-sm"
                  />
                )}
              </div>
            ))}

          {form.disabledReason && !form.supported ? (
            <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-[var(--color-text-muted)]">
              {form.disabledReason}
            </div>
          ) : null}
        </div>
      ) : null}

      {submitError ? (
        <div className="mt-3">
          <RuntimeProviderErrorAlert
            message={submitError}
            diagnostics={submitErrorDiagnostics}
            testId="runtime-provider-setup-submit-error"
          />
        </div>
      ) : null}

      <div className="mt-3 flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={actions.cancelConnect}
        >
          {t('runtimeProvider.actions.cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={disabled || busy || loading || !canSubmit}
          onClick={() => void actions.submitConnect(provider.providerId)}
        >
          {busy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}
          {form?.submitLabel ?? 'Connect'}
        </Button>
      </div>
    </div>
  );
}

function RuntimeSummary({
  state,
  onRefresh,
  disabled,
}: Pick<RuntimeProviderManagementPanelViewProps, 'state' | 'disabled'> & {
  onRefresh: () => void;
}): JSX.Element {
  const { t } = useAppTranslation('settings');
  const runtime = state.view?.runtime;
  const loadingWithoutRuntime = state.loading && !runtime;
  const defaultSourceLabel = getDefaultModelSourceLabel(state.view?.defaultModelSource);
  return (
    <div
      className="rounded-lg border p-3"
      aria-busy={state.loading}
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'rgba(255, 255, 255, 0.025)',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            {t('runtimeProvider.summary.title')}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <Badge
              variant="outline"
              className={`border-white/10 ${loadingWithoutRuntime ? 'bg-white/[0.04]' : ''}`}
            >
              {runtime
                ? formatRuntimeState(runtime)
                : state.loading
                  ? 'Checking runtime'
                  : 'Unavailable'}
            </Badge>
            {runtime?.version ? (
              <span style={{ color: 'var(--color-text-secondary)' }}>v{runtime.version}</span>
            ) : null}
            {state.view?.defaultModel ? (
              <span className="break-all" style={{ color: 'var(--color-text-secondary)' }}>
                {t('runtimeProvider.summary.defaultModel', { model: state.view.defaultModel })}
              </span>
            ) : null}
            {defaultSourceLabel ? (
              <span style={{ color: 'var(--color-text-muted)' }}>
                {t('runtimeProvider.summary.source', { source: defaultSourceLabel })}
              </span>
            ) : null}
          </div>
          {state.loading ? (
            <div
              className="mt-2 flex items-center gap-2 text-xs"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              <Loader2 className="size-3.5 animate-spin" />
              <span>{t('runtimeProvider.summary.loading')}</span>
            </div>
          ) : null}
          {state.view?.diagnostics.length ? (
            <div
              className="mt-2 space-y-1 text-[11px]"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {state.view.diagnostics.slice(0, 3).map((diagnostic, index) => (
                <div key={`diagnostic-${index}`}>{diagnostic}</div>
              ))}
            </div>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || state.loading}
          onClick={onRefresh}
        >
          {state.loading ? (
            <Loader2 className="mr-1 size-3.5 animate-spin" />
          ) : (
            <RefreshCcw className="mr-1 size-3.5" />
          )}
          {state.loading ? 'Checking...' : 'Refresh'}
        </Button>
      </div>
    </div>
  );
}

function RuntimeProviderLoadingPlaceholder(): JSX.Element {
  const { t } = useAppTranslation('settings');
  return (
    <div
      data-testid="runtime-provider-loading-skeleton"
      className="rounded-lg border p-3"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'rgba(255,255,255,0.02)',
      }}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <div
            className="skeleton-shimmer size-6 rounded-md border"
            style={{
              borderColor: 'var(--color-border-subtle)',
              backgroundColor: 'var(--skeleton-base)',
            }}
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
              {t('runtimeProvider.providers.loading')}
            </div>
            <div
              className="skeleton-shimmer mt-1 h-3 w-72 max-w-full rounded-sm"
              style={{ backgroundColor: 'var(--skeleton-base-dim)' }}
            />
          </div>
        </div>
        <div className="mt-3 space-y-2" aria-hidden="true">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="rounded-md border px-3 py-2.5"
              style={{
                borderColor: 'var(--color-border-subtle)',
                backgroundColor: 'rgba(255,255,255,0.018)',
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div
                      className="skeleton-shimmer size-5 rounded-md border"
                      style={{
                        borderColor: 'var(--color-border-subtle)',
                        backgroundColor: 'var(--skeleton-base)',
                      }}
                    />
                    <div
                      className="skeleton-shimmer h-4 rounded-sm"
                      style={{
                        width: index === 0 ? 120 : index === 1 ? 92 : 150,
                        backgroundColor: 'var(--skeleton-base)',
                      }}
                    />
                    <div
                      className="skeleton-shimmer h-5 rounded-md border"
                      style={{
                        width: index === 1 ? 72 : 96,
                        borderColor: 'var(--color-border-subtle)',
                        backgroundColor: 'var(--skeleton-base-dim)',
                      }}
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <div
                      className="skeleton-shimmer h-3 rounded-sm"
                      style={{
                        width: index === 2 ? 64 : 82,
                        backgroundColor: 'var(--skeleton-base-dim)',
                      }}
                    />
                    <div
                      className="skeleton-shimmer h-3 rounded-sm"
                      style={{
                        width: index === 0 ? 178 : 132,
                        backgroundColor: 'var(--skeleton-base-dim)',
                      }}
                    />
                  </div>
                </div>
                <div
                  className="skeleton-shimmer h-8 w-20 shrink-0 rounded-md border"
                  style={{
                    borderColor: 'var(--color-border-subtle)',
                    backgroundColor: 'var(--skeleton-base-dim)',
                  }}
                />
              </div>
            </div>
          ))}
          <div
            className="skeleton-shimmer h-9 rounded-md border"
            style={{
              width: '74%',
              borderColor: 'var(--color-border-subtle)',
              backgroundColor: 'var(--skeleton-base-dim)',
            }}
          />
        </div>
      </div>
    </div>
  );
}

function formatRuntimeProviderDiagnosticsCopyText(
  message: string,
  diagnostics: RuntimeProviderManagementErrorDiagnosticsDto | null | undefined
): string {
  const lines = ['OpenCode provider settings diagnostics', '', 'Message:', message.trim()];
  if (!diagnostics) {
    return lines.join('\n');
  }
  const hints = diagnostics.hints ?? [];

  const fields: Array<[string, string | number | null]> = [
    ['Error code', diagnostics.errorCode ?? null],
    ['Summary', diagnostics.summary],
    ['Likely cause', diagnostics.likelyCause],
    ['Resolved runtime binary', diagnostics.binaryPath],
    ['Command', diagnostics.command],
    ['Project path', diagnostics.projectPath],
    ['Exit code', diagnostics.exitCode],
  ];

  lines.push('', 'Structured diagnostics:');
  for (const [label, value] of fields) {
    if (value !== null && value !== '') {
      lines.push(`${label}: ${String(value)}`);
    }
  }

  if (hints.length > 0) {
    lines.push('', 'Hints:', ...hints.map((hint) => `- ${hint}`));
  }
  if (diagnostics.stderrPreview) {
    lines.push('', 'stderr preview:', diagnostics.stderrPreview);
  }
  if (diagnostics.stdoutPreview) {
    lines.push('', 'stdout preview:', diagnostics.stdoutPreview);
  }

  return lines.join('\n');
}

function getRuntimeProviderDiagnosticRows(
  diagnostics: RuntimeProviderManagementErrorDiagnosticsDto
): Array<[string, string]> {
  const rows: Array<[string, string | number | null]> = [
    ['Code', diagnostics.errorCode ?? null],
    ['Binary', diagnostics.binaryPath],
    ['Command', diagnostics.command],
    ['Project', diagnostics.projectPath],
    ['Exit', diagnostics.exitCode],
  ];
  return rows
    .filter(([, value]) => value !== null && value !== '')
    .map(([label, value]) => [label, String(value)]);
}

async function writeRuntimeProviderDiagnosticsToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall back to the selection API below.
    }
  }

  return copyRuntimeProviderDiagnosticsWithSelection(text);
}

function copyRuntimeProviderDiagnosticsWithSelection(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

const RuntimeProviderErrorAlert = ({
  message,
  diagnostics = null,
  testId,
}: RuntimeProviderErrorAlertProps): JSX.Element => {
  const { t } = useAppTranslation('settings');
  const [copied, setCopied] = useState(false);
  const [headline = message, ...detailLines] = message.trim().split(/\r?\n/);
  const fallbackDetails = detailLines.join('\n').trim();
  const hints = diagnostics?.hints ?? [];
  const copyText = useMemo(
    () => formatRuntimeProviderDiagnosticsCopyText(message, diagnostics),
    [diagnostics, message]
  );
  const diagnosticRows = diagnostics ? getRuntimeProviderDiagnosticRows(diagnostics) : [];
  const copyDiagnostics = useCallback(async (): Promise<void> => {
    setCopied(await writeRuntimeProviderDiagnosticsToClipboard(copyText));
  }, [copyText]);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timeout = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  return (
    <div
      data-testid={testId}
      role="alert"
      className="flex min-w-0 items-start gap-2 rounded-md border px-3 py-2 text-xs"
      style={{
        borderColor: 'rgba(248, 113, 113, 0.25)',
        backgroundColor: 'rgba(248, 113, 113, 0.06)',
        color: '#fca5a5',
      }}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 whitespace-pre-wrap break-words font-medium leading-5">
            {headline || message}
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={cn(
              'h-6 shrink-0 px-2 text-[11px]',
              !copied && 'member-launch-diagnostics-pulse'
            )}
            title={
              copied
                ? t('runtimeProvider.diagnostics.copied')
                : t('runtimeProvider.diagnostics.copy')
            }
            aria-label={
              copied
                ? t('runtimeProvider.diagnostics.copied')
                : t('runtimeProvider.diagnostics.copy')
            }
            onClick={(event) => {
              event.stopPropagation();
              void copyDiagnostics();
            }}
          >
            {copied ? <Check className="mr-1 size-3" /> : <ClipboardList className="mr-1 size-3" />}
            {copied
              ? t('runtimeProvider.diagnostics.copiedShort')
              : t('runtimeProvider.diagnostics.copy')}
          </Button>
        </div>
        {diagnostics ? (
          <div className="mt-2 space-y-2">
            {diagnostics.likelyCause ? (
              <div className="whitespace-pre-wrap break-words leading-5 text-red-100">
                <span className="font-medium text-red-100">
                  {t('runtimeProvider.diagnostics.likelyCause')}{' '}
                </span>
                {diagnostics.likelyCause}
              </div>
            ) : null}
            {diagnosticRows.length > 0 ? (
              <dl className="grid gap-1 rounded border px-2 py-1.5 text-[11px] leading-4 sm:grid-cols-[92px_minmax(0,1fr)]">
                {diagnosticRows.map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-red-200/75">{label}</dt>
                    <dd className="min-w-0 break-words font-mono text-red-100">{value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {hints.length > 0 ? (
              <div>
                <div className="mb-1 font-medium text-red-100">
                  {t('runtimeProvider.diagnostics.hints')}
                </div>
                <ul className="space-y-1 pl-4">
                  {hints.map((hint, index) => (
                    <li
                      key={`${hint}-${index}`}
                      className="list-disc whitespace-pre-wrap break-words"
                    >
                      {hint}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {diagnostics.stderrPreview ? (
              <pre
                data-testid={`${testId}-stderr-preview`}
                className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border px-2 py-1.5 font-mono text-[11px] leading-4"
                style={{
                  borderColor: 'rgba(248, 113, 113, 0.2)',
                  backgroundColor: 'rgba(15, 23, 42, 0.38)',
                  color: '#fecaca',
                }}
              >
                {`stderr preview:\n${diagnostics.stderrPreview}`}
              </pre>
            ) : null}
            {diagnostics.stdoutPreview ? (
              <pre
                data-testid={`${testId}-stdout-preview`}
                className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border px-2 py-1.5 font-mono text-[11px] leading-4"
                style={{
                  borderColor: 'rgba(248, 113, 113, 0.2)',
                  backgroundColor: 'rgba(15, 23, 42, 0.38)',
                  color: '#fecaca',
                }}
              >
                {`stdout preview:\n${diagnostics.stdoutPreview}`}
              </pre>
            ) : null}
          </div>
        ) : fallbackDetails ? (
          <pre
            className="m-0 mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border px-2 py-1.5 font-mono text-[11px] leading-4"
            style={{
              borderColor: 'rgba(248, 113, 113, 0.2)',
              backgroundColor: 'rgba(15, 23, 42, 0.38)',
              color: '#fecaca',
            }}
          >
            {fallbackDetails}
          </pre>
        ) : null}
      </div>
    </div>
  );
};

function RuntimeProviderModelLoadingSkeleton(): JSX.Element {
  return (
    <div className="space-y-2" data-testid="runtime-provider-model-loading-skeleton">
      {Array.from({ length: 3 }).map((_, index) => (
        <div
          key={index}
          className="rounded-md border px-3 py-2.5"
          style={{
            borderColor: 'var(--color-border-subtle)',
            backgroundColor: 'rgba(255,255,255,0.02)',
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div
                className="skeleton-shimmer h-4 rounded-sm"
                style={{
                  width: index === 0 ? '42%' : index === 1 ? '54%' : '36%',
                  backgroundColor: 'var(--skeleton-base)',
                }}
              />
              <div
                className="skeleton-shimmer mt-2 h-3 rounded-sm"
                style={{
                  width: index === 0 ? '64%' : index === 1 ? '46%' : '58%',
                  backgroundColor: 'var(--skeleton-base-dim)',
                }}
              />
            </div>
            <div
              className="skeleton-shimmer h-8 w-20 shrink-0 rounded-md border"
              style={{
                borderColor: 'var(--color-border-subtle)',
                backgroundColor: 'var(--skeleton-base-dim)',
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function ProviderActions({
  provider,
  busy,
  disabled,
  onStartConnect,
  onForget,
}: ProviderActionsProps): JSX.Element {
  const connect = getProviderAction(provider, 'connect');
  const forget = getProviderAction(provider, 'forget');
  const configure = getProviderAction(provider, 'configure');

  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {connect ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || busy || !connect.enabled}
          title={connect.disabledReason ?? undefined}
          onClick={(event) => {
            event.stopPropagation();
            onStartConnect();
          }}
        >
          {busy ? (
            <Loader2 className="mr-1 size-3.5 animate-spin" />
          ) : (
            <KeyRound className="mr-1 size-3.5" />
          )}
          {connect.label}
        </Button>
      ) : null}
      {forget ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || busy || !forget.enabled}
          title={forget.disabledReason ?? undefined}
          onClick={(event) => {
            event.stopPropagation();
            onForget();
          }}
        >
          {busy ? (
            <Loader2 className="mr-1 size-3.5 animate-spin" />
          ) : (
            <Trash2 className="mr-1 size-3.5" />
          )}
          {forget.label}
        </Button>
      ) : null}
      {configure ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled
          title={configure.disabledReason ?? undefined}
        >
          {configure.label}
        </Button>
      ) : null}
    </div>
  );
}

function ProviderRow({
  provider,
  state,
  active,
  formOpen,
  busy,
  disabled,
  hasProjectContext,
  actions,
}: ProviderRowProps): JSX.Element {
  const { t } = useAppTranslation('settings');
  const connect = getProviderAction(provider, 'connect');
  const test = getProviderAction(provider, 'test');
  const canOpenConnect = provider.state !== 'connected' && connect?.enabled === true;
  const canSelectModels =
    provider.modelCount > 0 && (provider.state === 'connected' || test?.enabled === true);
  const clickable = !disabled && (canOpenConnect || canSelectModels);
  const visuallyActive = active && (canSelectModels || formOpen);
  const handleActivate = (): void => {
    if (!clickable) {
      return;
    }
    if (canOpenConnect) {
      actions.startConnect(provider.providerId);
      return;
    }
    actions.selectProvider(provider.providerId);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    if (eventStartedInInteractiveChild(event.currentTarget, event.target)) {
      return;
    }
    event.preventDefault();
    handleActivate();
  };

  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : -1}
      data-testid={`runtime-provider-row-${provider.providerId}`}
      className={`rounded-lg border p-3 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/40 ${
        clickable
          ? 'cursor-pointer hover:border-sky-300/60 hover:bg-sky-400/[0.08] hover:shadow-[0_0_0_1px_rgba(125,211,252,0.18)]'
          : 'cursor-default'
      } ${
        visuallyActive
          ? 'border-sky-300/70 bg-sky-400/[0.075] shadow-[0_0_0_1px_rgba(125,211,252,0.22)]'
          : 'border-[var(--color-border-subtle)] bg-white/[0.02]'
      }`}
      onClick={handleActivate}
      onKeyDown={handleKeyDown}
    >
      <div className="grid w-full grid-cols-[1fr_auto] items-start gap-3">
        <div className="min-w-0 text-left">
          <div className="flex flex-wrap items-center gap-2">
            <ProviderBrandIcon provider={provider} />
            <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
              {provider.displayName}
            </span>
            {provider.recommended ? (
              <Badge variant="secondary">{t('runtimeProvider.providers.recommended')}</Badge>
            ) : null}
            <span
              className={`rounded-md border px-2 py-0.5 text-[11px] ${stateClassName(provider)}`}
              style={stateStyle(provider)}
            >
              {formatProviderState(provider)}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span style={{ color: 'var(--color-text-secondary)' }}>
              {getProviderModelsLabel(provider)}
            </span>
            {provider.defaultModelId ? (
              <span className="break-all" style={{ color: 'var(--color-text-secondary)' }}>
                {t('runtimeProvider.summary.defaultModel', { model: provider.defaultModelId })}
              </span>
            ) : null}
            {provider.ownership.map((owner) => (
              <Badge
                key={owner}
                variant="outline"
                className="border-white/10 px-1.5 py-0 text-[10px]"
              >
                {owner}
              </Badge>
            ))}
          </div>
          {provider.detail ? (
            <div className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {provider.detail}
            </div>
          ) : null}
        </div>
        <div className="flex justify-end">
          <ProviderActions
            provider={provider}
            busy={busy}
            disabled={disabled}
            onStartConnect={() => actions.startConnect(provider.providerId)}
            onForget={() => void actions.forgetProvider(provider.providerId)}
          />
        </div>
      </div>

      {formOpen ? (
        <ProviderSetupFormPanel
          provider={provider}
          state={state}
          busy={busy}
          disabled={disabled}
          actions={actions}
        />
      ) : null}

      {active && canSelectModels ? (
        <ProviderModelList
          state={state}
          actions={actions}
          provider={provider}
          disabled={disabled || busy}
          hasProjectContext={hasProjectContext}
        />
      ) : null}
    </div>
  );
}

function DirectoryProviderRow({
  provider,
  state,
  active,
  formOpen,
  disabled,
  busy,
  hasProjectContext,
  actions,
}: {
  readonly provider: RuntimeProviderDirectoryEntryDto;
  readonly state: RuntimeProviderManagementState;
  readonly active: boolean;
  readonly formOpen: boolean;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly hasProjectContext: boolean;
  readonly actions: RuntimeProviderManagementActions;
}): JSX.Element {
  const { t } = useAppTranslation('settings');
  const connect = getDirectoryAction(provider, 'connect');
  const configure = getDirectoryAction(provider, 'configure');
  const forget = getDirectoryAction(provider, 'forget');
  const test = getDirectoryAction(provider, 'test');
  const canOpenConnect = provider.state !== 'connected' && connect?.enabled === true;
  const canSelectModels =
    provider.modelCount !== 0 &&
    (provider.state === 'connected' ||
      provider.metadata.configuredAuthless === true ||
      test?.enabled === true);
  const clickable = !disabled && (canOpenConnect || canSelectModels);
  const visuallyActive = active && (canSelectModels || formOpen);
  const handleActivate = (): void => {
    if (!clickable) {
      return;
    }
    if (canOpenConnect) {
      actions.startConnect(provider.providerId);
      return;
    }
    actions.selectDirectoryProvider(provider.providerId);
  };

  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : -1}
      data-testid={`runtime-provider-directory-row-${provider.providerId}`}
      className={`rounded-lg border p-3 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/40 ${
        clickable
          ? 'cursor-pointer hover:border-sky-300/60 hover:bg-sky-400/[0.08]'
          : 'cursor-default'
      } ${
        visuallyActive
          ? 'border-sky-300/70 bg-sky-400/[0.075] shadow-[0_0_0_1px_rgba(125,211,252,0.22)]'
          : 'border-[var(--color-border-subtle)] bg-white/[0.02]'
      }`}
      onClick={handleActivate}
      onKeyDown={(event) => {
        if (!clickable || (event.key !== 'Enter' && event.key !== ' ')) {
          return;
        }
        if (eventStartedInInteractiveChild(event.currentTarget, event.target)) {
          return;
        }
        event.preventDefault();
        handleActivate();
      }}
    >
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ProviderBrandIcon provider={provider} />
            <span className="text-sm font-medium text-[var(--color-text)]">
              {provider.displayName}
            </span>
            {provider.recommended ? (
              <Badge variant="secondary">{t('runtimeProvider.providers.recommended')}</Badge>
            ) : null}
            <span
              className={`rounded-md border px-2 py-0.5 text-[11px] ${directorySetupKindClassName(provider)}`}
            >
              {formatDirectorySetupKind(provider)}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-text-secondary)]">
            <span>{getDirectoryModelsLabel(provider)}</span>
            {provider.sourceLabel ? <span>{provider.sourceLabel}</span> : null}
            {provider.providerSource ? <span>{provider.providerSource}</span> : null}
            {provider.ownership.map((owner) => (
              <Badge
                key={owner}
                variant="outline"
                className="border-white/10 px-1.5 py-0 text-[10px]"
              >
                {owner}
              </Badge>
            ))}
          </div>
          {provider.detail ? (
            <div className="mt-1 text-xs text-[var(--color-text-muted)]">{provider.detail}</div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-start justify-end gap-1.5">
          {connect ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || busy || !connect.enabled}
              title={connect.disabledReason ?? undefined}
              onClick={(event) => {
                event.stopPropagation();
                actions.startConnect(provider.providerId);
              }}
            >
              {busy ? (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              ) : (
                <KeyRound className="mr-1 size-3.5" />
              )}
              {connect.label}
            </Button>
          ) : null}
          {forget ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || busy || !forget.enabled}
              title={forget.disabledReason ?? undefined}
              onClick={(event) => {
                event.stopPropagation();
                void actions.forgetProvider(provider.providerId);
              }}
            >
              {busy ? (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-1 size-3.5" />
              )}
              {forget.label}
            </Button>
          ) : null}
          {configure ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled
              title={configure.disabledReason ?? undefined}
              onClick={(event) => event.stopPropagation()}
            >
              {configure.label}
            </Button>
          ) : null}
        </div>
      </div>

      {formOpen ? (
        <ProviderSetupFormPanel
          provider={directoryEntryToProviderConnection(provider)}
          state={state}
          busy={busy}
          disabled={disabled}
          actions={actions}
        />
      ) : null}

      {active && canSelectModels ? (
        <ProviderModelList
          state={state}
          actions={actions}
          provider={directoryEntryToProviderConnection(provider)}
          disabled={disabled || busy}
          hasProjectContext={hasProjectContext}
        />
      ) : null}
    </div>
  );
}

function ModelBadges({
  model,
  usedForNewTeams,
}: {
  readonly model: RuntimeProviderModelDto;
  readonly usedForNewTeams: boolean;
}): JSX.Element | null {
  const { t } = useAppTranslation('settings');
  const modelRecommendation = getOpenCodeTeamModelRecommendation(model.modelId);
  const localRoute = model.routeKind === 'configured_local';
  const connectedRoute = model.routeKind === 'connected_provider';
  const freeModel = isFreeRuntimeProviderModel(model);
  const verified =
    model.proofState === 'verified' ||
    model.availability === 'available' ||
    model.accessKind === 'verified';
  const needsTest = model.proofState === 'needs_probe' || model.requiresExecutionProof === true;
  const failed =
    model.proofState === 'failed' ||
    model.accessKind === 'execution_failed' ||
    model.availability === 'unavailable' ||
    model.availability === 'not-authenticated';
  const unknown = model.accessKind === 'unknown_model' || model.accessKind === 'no_model';

  if (
    !freeModel &&
    !model.default &&
    !usedForNewTeams &&
    !modelRecommendation &&
    !localRoute &&
    !connectedRoute &&
    !verified &&
    !needsTest &&
    !failed &&
    !unknown
  ) {
    return null;
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {modelRecommendation ? (
        <Badge
          className={
            modelRecommendation.level === 'recommended'
              ? 'bg-emerald-400/15 px-1.5 py-0 text-[10px] text-emerald-200'
              : modelRecommendation.level === 'recommended-with-limits'
                ? 'bg-amber-400/15 px-1.5 py-0 text-[10px] text-amber-200'
                : modelRecommendation.level === 'tested'
                  ? 'bg-sky-400/15 px-1.5 py-0 text-[10px] text-sky-200'
                  : modelRecommendation.level === 'tested-with-limits'
                    ? 'bg-cyan-400/15 px-1.5 py-0 text-[10px] text-cyan-200'
                    : modelRecommendation.level === 'unavailable-in-opencode'
                      ? 'bg-slate-400/15 px-1.5 py-0 text-[10px] text-slate-200'
                      : 'bg-red-400/15 px-1.5 py-0 text-[10px] text-red-200'
          }
          title={modelRecommendation.reason}
        >
          {modelRecommendation.level === 'not-recommended' ||
          modelRecommendation.level === 'unavailable-in-opencode' ? (
            <AlertTriangle className="mr-1 size-3" />
          ) : modelRecommendation.level === 'tested' ||
            modelRecommendation.level === 'tested-with-limits' ? (
            <CheckCircle2 className="mr-1 size-3" />
          ) : (
            <Star className="mr-1 size-3 fill-current" />
          )}
          {modelRecommendation.label}
        </Badge>
      ) : null}
      {usedForNewTeams ? (
        <Badge className="bg-sky-400/15 px-1.5 py-0 text-[10px] text-sky-100">
          <Star className="mr-1 size-3" />
          {t('runtimeProvider.badges.usedInTeamPicker')}
        </Badge>
      ) : null}
      {freeModel ? (
        <Badge className="bg-emerald-400/15 px-1.5 py-0 text-[10px] text-emerald-200">
          {t('runtimeProvider.badges.free')}
        </Badge>
      ) : null}
      {localRoute ? (
        <>
          <Badge className="bg-cyan-400/15 px-1.5 py-0 text-[10px] text-cyan-200">
            {t('runtimeProvider.badges.local')}
          </Badge>
          <Badge className="bg-sky-400/15 px-1.5 py-0 text-[10px] text-sky-200">
            {t('runtimeProvider.badges.configured')}
          </Badge>
        </>
      ) : null}
      {connectedRoute ? (
        <Badge className="bg-emerald-400/15 px-1.5 py-0 text-[10px] text-emerald-100">
          {t('runtimeProvider.badges.connected')}
        </Badge>
      ) : null}
      {verified ? (
        <Badge className="bg-emerald-400/15 px-1.5 py-0 text-[10px] text-emerald-100">
          {t('runtimeProvider.badges.verified')}
        </Badge>
      ) : null}
      {needsTest && !verified ? (
        <Badge className="bg-amber-400/15 px-1.5 py-0 text-[10px] text-amber-200">
          {t('runtimeProvider.badges.needsTest')}
        </Badge>
      ) : null}
      {failed ? (
        <Badge className="bg-red-400/15 px-1.5 py-0 text-[10px] text-red-200">
          {t('runtimeProvider.badges.failed')}
        </Badge>
      ) : null}
      {unknown ? (
        <Badge className="bg-slate-400/15 px-1.5 py-0 text-[10px] text-slate-200">
          {t('runtimeProvider.badges.unknown')}
        </Badge>
      ) : null}
      {model.default ? (
        <Badge className="bg-amber-400/15 px-1.5 py-0 text-[10px] text-amber-200">
          {t('runtimeProvider.badges.default')}
        </Badge>
      ) : null}
    </div>
  );
}

function isFreeRuntimeProviderModel(model: RuntimeProviderModelDto): boolean {
  const normalizedModelId = model.modelId.trim().toLowerCase();
  return (
    model.free ||
    model.routeKind === 'builtin_free' ||
    model.accessKind === 'builtin_free' ||
    normalizedModelId === 'opencode/big-pickle' ||
    normalizedModelId.includes(':free') ||
    normalizedModelId.endsWith('-free') ||
    normalizedModelId.endsWith('/free')
  );
}

function isUnknownOpenCodeModelRoute(model: RuntimeProviderModelDto): boolean {
  return model.accessKind === 'unknown_model' || model.accessKind === 'no_model';
}

function canTestOpenCodeModelRoute(model: RuntimeProviderModelDto): boolean {
  return !isUnknownOpenCodeModelRoute(model);
}

function canUseOpenCodeModelRoute(model: RuntimeProviderModelDto): boolean {
  return (
    !isUnknownOpenCodeModelRoute(model) &&
    model.accessKind !== 'not_authenticated' &&
    model.accessKind !== 'execution_failed' &&
    model.proofState !== 'failed'
  );
}

function getOpenCodeRouteUnavailableTitle(model: RuntimeProviderModelDto): string | undefined {
  if (isUnknownOpenCodeModelRoute(model)) {
    return 'This model is the current OpenCode default, but it is not available in the live catalog yet.';
  }
  if (model.accessKind === 'not_authenticated') {
    return (
      model.accessReason ?? 'This provider requires authentication before this model can be used.'
    );
  }
  if (model.accessKind === 'execution_failed' || model.proofState === 'failed') {
    return model.accessReason ?? 'This model route failed its last execution test.';
  }
  return undefined;
}

function getOpenCodeModelSearchText(model: RuntimeProviderModelDto): string {
  const recommendation = getOpenCodeTeamModelRecommendation(model.modelId);
  return [
    model.providerId,
    model.modelId,
    model.displayName,
    model.sourceLabel,
    model.accessKind,
    model.routeKind,
    model.proofState,
    model.availability,
    model.accessReason ?? '',
    isFreeRuntimeProviderModel(model) ? 'free' : '',
    model.default ? 'default' : '',
    model.requiresExecutionProof ? 'needs test needs probe' : '',
    recommendation?.label ?? '',
    recommendation?.level ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

function ModelResult({
  result,
}: {
  readonly result: RuntimeProviderModelTestResultDto | undefined;
}): JSX.Element | null {
  if (!result) {
    return null;
  }
  return (
    <div
      className="mt-2 text-xs"
      style={{ color: result.ok ? '#86efac' : '#fecaca' }}
      data-testid={`runtime-provider-model-result-${result.modelId}`}
    >
      {result.message}
    </div>
  );
}

function ModelRow({
  provider,
  model,
  selected,
  disabled,
  hasProjectContext,
  testing,
  result,
  actions,
}: {
  readonly provider: RuntimeProviderConnectionDto;
  readonly model: RuntimeProviderModelDto;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly hasProjectContext: boolean;
  readonly testing: boolean;
  readonly result: RuntimeProviderModelTestResultDto | undefined;
  readonly actions: RuntimeProviderManagementActions;
}): JSX.Element {
  const { t } = useAppTranslation('settings');
  const chooseModel = (): void => {
    if (!disabled) {
      actions.useModelForNewTeams(model.modelId);
    }
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    if (eventStartedInInteractiveChild(event.currentTarget, event.target)) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    chooseModel();
  };

  return (
    <div
      role={disabled ? undefined : 'button'}
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-pressed={disabled ? undefined : selected}
      data-testid={`runtime-provider-model-row-${model.modelId}`}
      className={`rounded-md border px-3 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/45 ${
        disabled ? 'cursor-default' : 'cursor-pointer'
      }`}
      onClick={(event) => {
        event.stopPropagation();
        chooseModel();
      }}
      onKeyDown={handleKeyDown}
      style={{
        borderColor: selected ? 'rgba(96, 165, 250, 0.45)' : 'var(--color-border-subtle)',
        backgroundColor: selected ? 'rgba(96, 165, 250, 0.06)' : 'rgba(255,255,255,0.02)',
      }}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div className="block w-full min-w-0 text-left">
          <div
            className="text-sm font-medium leading-5"
            style={{ color: 'var(--color-text)', overflowWrap: 'anywhere' }}
          >
            {model.displayName}
          </div>
          <div
            className="mt-1 text-[11px] leading-4"
            style={{ color: 'var(--color-text-muted)', overflowWrap: 'anywhere' }}
          >
            {model.modelId}
          </div>
          <ModelBadges model={model} usedForNewTeams={selected} />
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 min-w-20 justify-center"
            disabled={disabled || !hasProjectContext || testing}
            title={
              hasProjectContext ? undefined : t('runtimeProvider.models.selectProjectBeforeTesting')
            }
            onClick={(event) => {
              event.stopPropagation();
              if (!hasProjectContext) return;
              void actions.testModel(provider.providerId, model.modelId);
            }}
          >
            {testing ? (
              <Loader2 className="mr-1 size-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-1 size-3.5" />
            )}
            {t('runtimeProvider.actions.test')}
          </Button>
        </div>
      </div>
      <ModelResult result={result} />
    </div>
  );
}

function OpenCodeModelScopeControls({
  defaultScope,
  onDefaultScopeChange,
  projectPath,
  projects,
  loading,
  error,
  onProjectContextChange,
}: {
  readonly defaultScope: RuntimeProviderDefaultScopeDto;
  readonly onDefaultScopeChange: (scope: RuntimeProviderDefaultScopeDto) => void;
  readonly projectPath: string | null | undefined;
  readonly projects: readonly ProjectPathProject[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly onProjectContextChange?: (projectPath: string | null) => void;
}): JSX.Element {
  const { t } = useAppTranslation('settings');
  const selectedValue = projectPath?.trim() || NO_PROJECT_CONTEXT_VALUE;
  const projectOptions = useMemo(() => {
    const seen = new Set<string>();
    const options = projects.filter((project) => {
      const normalized = project.path.trim();
      if (!normalized || seen.has(normalized) || project.filesystemState === 'deleted') {
        return false;
      }
      seen.add(normalized);
      return true;
    });
    const currentPath = projectPath?.trim();
    if (currentPath && !seen.has(currentPath)) {
      options.unshift({
        id: currentPath,
        path: currentPath,
        name: getProjectContextName(currentPath) ?? currentPath,
        sessions: [],
        totalSessions: 0,
        createdAt: 0,
      });
    }
    return options;
  }, [projectPath, projects]);
  const contextPlaceholder = loading
    ? t('runtimeProvider.defaults.loadingContexts')
    : defaultScope === 'all_projects'
      ? t('runtimeProvider.defaults.selectValidationContext')
      : t('runtimeProvider.defaults.selectProjectContext');

  return (
    <div
      className="rounded-lg border p-3"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'rgba(255,255,255,0.02)',
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--color-text)]">
            {t('runtimeProvider.defaults.title')}
          </div>
          <div className="mt-1 text-xs text-[var(--color-text-muted)]">
            {getDefaultScopeDescription(defaultScope, t)}
          </div>
        </div>
        <div className="inline-flex shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
          {(['all_projects', 'project'] as const).map((scope) => (
            <button
              key={scope}
              type="button"
              className={`rounded-[3px] px-3 py-1 text-xs font-medium transition-colors ${
                defaultScope === scope
                  ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
              }`}
              onClick={() => onDefaultScopeChange(scope)}
            >
              {scope === 'all_projects'
                ? t('runtimeProvider.defaults.allProjects')
                : t('runtimeProvider.defaults.thisProject')}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3">
        <div className="min-w-0">
          <Label className="text-xs text-[var(--color-text-secondary)]">
            {getContextControlLabel(defaultScope, t)}
          </Label>
          <div className="mt-1">
            <Select
              value={selectedValue}
              disabled={loading || !onProjectContextChange}
              onValueChange={(value) => {
                onProjectContextChange?.(value === NO_PROJECT_CONTEXT_VALUE ? null : value);
              }}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder={contextPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PROJECT_CONTEXT_VALUE}>{contextPlaceholder}</SelectItem>
                {projectOptions.map((project) => (
                  <SelectItem key={project.path} value={project.path}>
                    {project.name || getProjectContextName(project.path) || project.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div
          className="mt-1 text-[11px] leading-4 text-[var(--color-text-muted)]"
          title={projectPath?.trim() || undefined}
        >
          {getContextControlHint(defaultScope, projectPath, t)}
        </div>
      </div>

      {error ? (
        <div className="mt-2 rounded-md border border-red-400/25 bg-red-400/10 px-2 py-1.5 text-xs text-red-200">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function ConfiguredOpenCodeModelsPanel({
  state,
  actions,
  disabled,
  defaultScope,
  hasProjectContext,
}: {
  readonly state: RuntimeProviderManagementState;
  readonly actions: RuntimeProviderManagementActions;
  readonly disabled: boolean;
  readonly defaultScope: RuntimeProviderDefaultScopeDto;
  readonly hasProjectContext: boolean;
}): JSX.Element | null {
  const { t } = useAppTranslation('settings');
  const models = useMemo(() => state.view?.configuredModels ?? [], [state.view?.configuredModels]);
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const visibleModels = useMemo(
    () =>
      normalizedQuery
        ? models.filter((model) => getOpenCodeModelSearchText(model).includes(normalizedQuery))
        : models,
    [models, normalizedQuery]
  );
  if (models.length === 0) {
    return null;
  }

  return (
    <div
      className="rounded-lg border p-3"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'rgba(255, 255, 255, 0.025)',
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--color-text)]">
            {t('runtimeProvider.models.launchableTitle')}
          </div>
          <div className="text-xs text-[var(--color-text-muted)]">
            {t('runtimeProvider.models.launchableDescription')}
          </div>
        </div>
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('runtimeProvider.modelRoutes.searchPlaceholder')}
            className="h-9 pl-10 pr-3 text-sm leading-5"
            style={{ paddingLeft: 40 }}
          />
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {visibleModels.length === 0 ? (
          <div className="rounded-md border border-dashed border-white/10 px-3 py-3 text-sm text-[var(--color-text-muted)]">
            {t('runtimeProvider.models.noRoutesMatch', { query: query.trim() })}
          </div>
        ) : null}
        {visibleModels.map((model) => {
          const selected = state.selectedModelId === model.modelId;
          const testing = state.testingModelIds.includes(model.modelId);
          const savingDefault = state.savingDefaultModelId === model.modelId;
          const result = state.modelResults[model.modelId];
          const unavailableTitle = getOpenCodeRouteUnavailableTitle(model);
          const contextRequiredTitle = hasProjectContext
            ? undefined
            : t('runtimeProvider.models.selectProjectBeforeTestingDefaults');
          const alreadyDefaultForScope = isDefaultForScope(model, state, defaultScope);
          const canTest =
            !disabled && hasProjectContext && !testing && canTestOpenCodeModelRoute(model);
          const canUse = !disabled && canUseOpenCodeModelRoute(model);
          const canSetDefault =
            !disabled &&
            hasProjectContext &&
            !savingDefault &&
            !alreadyDefaultForScope &&
            canUseOpenCodeModelRoute(model);
          return (
            <div
              key={model.modelId}
              data-testid={`configured-opencode-model-row-${model.modelId}`}
              className="rounded-md border px-3 py-2.5"
              style={{
                borderColor: selected ? 'rgba(96, 165, 250, 0.45)' : 'var(--color-border-subtle)',
                backgroundColor: selected ? 'rgba(96, 165, 250, 0.06)' : 'rgba(255,255,255,0.02)',
              }}
            >
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                <div className="min-w-0">
                  <div
                    className="text-sm font-medium leading-5"
                    style={{ color: 'var(--color-text)', overflowWrap: 'anywhere' }}
                  >
                    {model.displayName}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
                    <span className="break-all">{model.modelId}</span>
                    <span>{model.sourceLabel}</span>
                  </div>
                  <ModelBadges model={model} usedForNewTeams={selected} />
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    disabled={!canTest}
                    title={canTest ? undefined : (contextRequiredTitle ?? unavailableTitle)}
                    onClick={() => {
                      if (!canTest) return;
                      void actions.testModel(model.providerId, model.modelId);
                    }}
                  >
                    {testing ? (
                      <Loader2 className="mr-1 size-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="mr-1 size-3.5" />
                    )}
                    {t('runtimeProvider.actions.test')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8"
                    disabled={!canUse}
                    title={canUse ? undefined : unavailableTitle}
                    onClick={() => {
                      if (!canUse) return;
                      actions.useModelForNewTeams(model.modelId);
                    }}
                  >
                    {t('runtimeProvider.models.useInTeamPicker')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8"
                    disabled={!canSetDefault}
                    title={
                      canSetDefault
                        ? undefined
                        : (contextRequiredTitle ??
                          (alreadyDefaultForScope
                            ? t('runtimeProvider.models.alreadyDefault')
                            : unavailableTitle))
                    }
                    onClick={() => {
                      if (!canSetDefault) return;
                      void actions.setDefaultModel(model.providerId, model.modelId, defaultScope);
                    }}
                  >
                    {savingDefault ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}
                    {getDefaultScopeButtonLabel(defaultScope, t)}
                  </Button>
                </div>
              </div>
              <ModelResult result={result} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProviderModelList({
  state,
  actions,
  provider,
  disabled,
  hasProjectContext,
}: {
  readonly state: RuntimeProviderManagementState;
  readonly actions: RuntimeProviderManagementActions;
  readonly provider: RuntimeProviderConnectionDto;
  readonly disabled: boolean;
  readonly hasProjectContext: boolean;
}): JSX.Element {
  const { t } = useAppTranslation('settings');
  const pickerOpen = state.modelPickerProviderId === provider.providerId;
  const [recommendedOnly, setRecommendedOnly] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  const hasRecommendedModels = useMemo(
    () => state.models.some((model) => isOpenCodeTeamModelRecommended(model.modelId)),
    [state.models]
  );
  const hasFreeModels = useMemo(
    () => state.models.some((model) => isFreeRuntimeProviderModel(model)),
    [state.models]
  );

  useEffect(() => {
    if (!hasRecommendedModels) {
      setRecommendedOnly(false);
    }
  }, [hasRecommendedModels]);

  useEffect(() => {
    if (!hasFreeModels) {
      setFreeOnly(false);
    }
  }, [hasFreeModels]);

  const visibleModels = useMemo(
    () =>
      state.models
        .map((model, index) => ({ model, index }))
        .filter(({ model }) => !recommendedOnly || isOpenCodeTeamModelRecommended(model.modelId))
        .filter(({ model }) => !freeOnly || isFreeRuntimeProviderModel(model))
        .sort((left, right) => {
          const recommendationOrder = compareOpenCodeTeamModelRecommendations(
            left.model.modelId,
            right.model.modelId
          );
          return recommendationOrder || left.index - right.index;
        })
        .map(({ model }) => model),
    [freeOnly, recommendedOnly, state.models]
  );
  const emptyModelListMessage = recommendedOnly
    ? freeOnly
      ? t('runtimeProvider.models.emptyRecommendedFree')
      : t('runtimeProvider.models.emptyRecommended')
    : freeOnly
      ? t('runtimeProvider.models.emptyFree')
      : t('runtimeProvider.models.empty');

  return (
    <div className="mt-4 space-y-3 border-t border-white/10 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <Input
            data-testid="runtime-provider-model-search"
            value={state.modelQuery}
            disabled={disabled}
            onChange={(event) => actions.setModelQuery(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder={t('runtimeProvider.models.searchPlaceholder')}
            className="h-10 pl-10 pr-3 text-sm leading-5"
            style={{ paddingLeft: 42 }}
          />
        </div>
        {hasRecommendedModels ? (
          <div
            className="flex h-10 items-center gap-2 rounded-md border border-white/10 px-3"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <Checkbox
              id={`runtime-provider-${provider.providerId}-recommended-only`}
              checked={recommendedOnly}
              disabled={disabled || state.modelsLoading}
              onCheckedChange={(checked) => setRecommendedOnly(checked === true)}
              className="size-3.5"
            />
            <Label
              htmlFor={`runtime-provider-${provider.providerId}-recommended-only`}
              className="cursor-pointer text-xs font-normal text-[var(--color-text-secondary)]"
            >
              {t('runtimeProvider.models.recommendedOnly')}
            </Label>
          </div>
        ) : null}
        {hasFreeModels ? (
          <div
            className="flex h-10 items-center gap-2 rounded-md border border-white/10 px-3"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <Checkbox
              id={`runtime-provider-${provider.providerId}-free-only`}
              checked={freeOnly}
              disabled={disabled || state.modelsLoading}
              onCheckedChange={(checked) => setFreeOnly(checked === true)}
              className="size-3.5"
            />
            <Label
              htmlFor={`runtime-provider-${provider.providerId}-free-only`}
              className="cursor-pointer text-xs font-normal text-[var(--color-text-secondary)]"
            >
              {t('runtimeProvider.models.freeOnly')}
            </Label>
          </div>
        ) : null}
      </div>

      {state.modelsError ? (
        <RuntimeProviderErrorAlert
          message={state.modelsError}
          diagnostics={state.modelsErrorDiagnostics}
          testId="runtime-provider-models-error"
        />
      ) : null}

      <div
        data-testid="runtime-provider-model-list"
        className="space-y-2 overflow-y-auto pr-1"
        style={{ maxHeight: 300 }}
      >
        {!pickerOpen || state.modelsLoading ? <RuntimeProviderModelLoadingSkeleton /> : null}
        {pickerOpen && !state.modelsLoading && visibleModels.length === 0 && !state.modelsError ? (
          <div className="text-sm text-[var(--color-text-muted)]">{emptyModelListMessage}</div>
        ) : null}
        {pickerOpen
          ? visibleModels.map((model) => (
              <ModelRow
                key={model.modelId}
                provider={provider}
                model={model}
                selected={state.selectedModelId === model.modelId}
                disabled={disabled}
                hasProjectContext={hasProjectContext}
                testing={state.testingModelIds.includes(model.modelId)}
                result={state.modelResults[model.modelId]}
                actions={actions}
              />
            ))
          : null}
      </div>
    </div>
  );
}

export function RuntimeProviderManagementPanelView({
  state,
  actions,
  disabled,
  projectPath = null,
  projectContextProjects = [],
  projectContextLoading = false,
  projectContextError = null,
  onProjectContextChange,
}: RuntimeProviderManagementPanelViewProps): JSX.Element {
  const { t } = useAppTranslation('settings');
  const [selectedSection, setSelectedSection] = useState<OpenCodeSettingsSection | null>(null);
  const [defaultScope, setDefaultScope] = useState<RuntimeProviderDefaultScopeDto>('all_projects');
  const providerQuery = state.providerQuery.trim().toLowerCase();
  const filteredProviders = providerQuery
    ? state.providers.filter((provider) =>
        [
          provider.providerId,
          provider.displayName,
          provider.detail ?? '',
          provider.defaultModelId ?? '',
          getProviderModelsLabel(provider),
          formatProviderState(provider),
        ]
          .join(' ')
          .toLowerCase()
          .includes(providerQuery)
      )
    : state.providers;
  const useDirectoryRows =
    state.directorySupported &&
    (state.directoryLoaded || state.directoryLoading || state.directoryEntries.length > 0);
  const visibleDirectoryRows = state.directoryEntries.filter((provider) =>
    directoryEntryMatchesQuery(provider, providerQuery)
  );
  const providerCountLabel =
    state.directoryTotalCount !== null
      ? formatOpenCodeProviderCount(state.directoryTotalCount)
      : state.directorySupported
        ? t('runtimeProvider.providers.catalog')
        : t('runtimeProvider.providers.countFallback');
  const launchableModelCount = state.view?.configuredModels?.length ?? 0;
  const modelsLoading = state.loading && launchableModelCount === 0;
  const activeSection =
    selectedSection ?? (modelsLoading || launchableModelCount > 0 ? 'models' : 'providers');
  const hasProjectContext = Boolean(projectPath?.trim());

  return (
    <div className="space-y-3">
      <RuntimeSummary state={state} disabled={disabled} onRefresh={() => void actions.refresh()} />

      {state.error ? (
        <RuntimeProviderErrorAlert
          message={state.error}
          diagnostics={state.errorDiagnostics}
          testId="runtime-provider-error"
        />
      ) : null}

      {state.successMessage ? (
        <div
          className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
          style={{
            borderColor: 'rgba(74, 222, 128, 0.25)',
            backgroundColor: 'rgba(74, 222, 128, 0.08)',
            color: '#86efac',
          }}
        >
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
          <span>{state.successMessage}</span>
        </div>
      ) : null}

      <Tabs
        value={activeSection}
        onValueChange={(value) => setSelectedSection(value as OpenCodeSettingsSection)}
      >
        <div className="border-b border-white/10">
          <TabsList className="gap-1 rounded-b-none">
            <TabsTrigger
              value="models"
              className="rounded-b-none data-[state=active]:bg-[var(--color-surface)]"
            >
              {t('runtimeProvider.tabs.models')}
              {launchableModelCount > 0 ? (
                <span className="ml-2 rounded-full bg-white/10 px-1.5 py-0 text-[10px]">
                  {launchableModelCount}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger
              value="providers"
              className="rounded-b-none data-[state=active]:bg-[var(--color-surface)]"
            >
              {t('runtimeProvider.tabs.providers')}
              {state.directoryTotalCount !== null ? (
                <span className="ml-2 rounded-full bg-white/10 px-1.5 py-0 text-[10px]">
                  {state.directoryTotalCount}
                </span>
              ) : null}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="models" className="mt-3 space-y-3">
          <OpenCodeModelScopeControls
            defaultScope={defaultScope}
            onDefaultScopeChange={setDefaultScope}
            projectPath={projectPath}
            projects={projectContextProjects}
            loading={projectContextLoading}
            error={projectContextError}
            onProjectContextChange={onProjectContextChange}
          />
          <ConfiguredOpenCodeModelsPanel
            state={state}
            actions={actions}
            disabled={disabled}
            defaultScope={defaultScope}
            hasProjectContext={hasProjectContext}
          />
          {modelsLoading ? (
            <div
              className="rounded-lg border p-3"
              style={{
                borderColor: 'var(--color-border-subtle)',
                backgroundColor: 'rgba(255,255,255,0.02)',
              }}
            >
              <div className="mb-3 flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
                <Loader2 className="size-3.5 animate-spin" />
                {t('runtimeProvider.models.loadingRoutes')}
              </div>
              <RuntimeProviderModelLoadingSkeleton />
            </div>
          ) : null}
          {!modelsLoading && launchableModelCount === 0 ? (
            <div className="rounded-lg border border-dashed border-white/10 p-4 text-sm text-[var(--color-text-muted)]">
              {t('runtimeProvider.models.noneReported')}
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="providers" className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-medium text-[var(--color-text)]">
                {t('runtimeProvider.tabs.providers')}
              </div>
              <div className="text-xs text-[var(--color-text-muted)]">
                {t('runtimeProvider.providers.description', { count: providerCountLabel })}
              </div>
            </div>
            {state.directorySupported ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled || state.directoryLoading || state.directoryRefreshing}
                onClick={() => void actions.refreshDirectory()}
              >
                {state.directoryRefreshing ? (
                  <Loader2 className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <RefreshCcw className="mr-1 size-3.5" />
                )}
                {t('runtimeProvider.providers.refreshCatalog')}
              </Button>
            ) : null}
          </div>

          {state.providers.length > 0 || state.directorySupported ? (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <Input
                data-testid="runtime-provider-search"
                value={state.providerQuery}
                disabled={disabled || state.loading}
                onChange={(event) => actions.setProviderQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && state.providerQuery.trim().length >= 2) {
                    actions.searchAllProviders(state.providerQuery.trim());
                  }
                }}
                placeholder={t('runtimeProvider.providers.searchPlaceholder')}
                className="h-9 pr-3 text-sm"
                style={{ paddingLeft: 40 }}
              />
            </div>
          ) : null}

          {state.directoryError ? (
            <RuntimeProviderErrorAlert
              message={state.directoryError}
              diagnostics={state.directoryErrorDiagnostics}
              testId="runtime-provider-directory-error"
            />
          ) : null}

          <div className="max-h-[min(52vh,640px)] space-y-2 overflow-y-auto pr-1">
            {useDirectoryRows ? (
              <>
                {state.directoryLoading && state.directoryEntries.length === 0 ? (
                  <RuntimeProviderLoadingPlaceholder />
                ) : null}
                {visibleDirectoryRows.map((provider) => (
                  <DirectoryProviderRow
                    key={provider.providerId}
                    provider={provider}
                    state={state}
                    active={provider.providerId === state.selectedProviderId}
                    formOpen={state.activeFormProviderId === provider.providerId}
                    busy={state.savingProviderId === provider.providerId}
                    disabled={disabled || state.directoryLoading}
                    hasProjectContext={hasProjectContext}
                    actions={actions}
                  />
                ))}
                {state.directoryNextCursor ? (
                  <div className="flex justify-center py-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={disabled || state.directoryRefreshing}
                      onClick={() => void actions.loadMoreDirectory()}
                    >
                      {state.directoryRefreshing ? (
                        <Loader2 className="mr-1 size-3.5 animate-spin" />
                      ) : null}
                      {t('runtimeProvider.providers.loadMore')}
                    </Button>
                  </div>
                ) : null}
              </>
            ) : (
              <>
                {state.loading && state.providers.length === 0 ? (
                  <RuntimeProviderLoadingPlaceholder />
                ) : null}
                {filteredProviders.map((provider) => (
                  <ProviderRow
                    key={provider.providerId}
                    provider={provider}
                    state={state}
                    active={provider.providerId === state.selectedProviderId}
                    formOpen={state.activeFormProviderId === provider.providerId}
                    busy={state.savingProviderId === provider.providerId}
                    disabled={disabled || state.loading}
                    hasProjectContext={hasProjectContext}
                    actions={actions}
                  />
                ))}
              </>
            )}
          </div>

          {useDirectoryRows &&
          !state.directoryLoading &&
          visibleDirectoryRows.length === 0 &&
          !state.directoryError ? (
            <div
              className="rounded-lg border p-3 text-sm"
              style={{
                borderColor: 'var(--color-border-subtle)',
                color: 'var(--color-text-secondary)',
              }}
            >
              {t('runtimeProvider.providers.noMatches')}
            </div>
          ) : null}

          {!useDirectoryRows &&
          !state.loading &&
          state.providers.length > 0 &&
          filteredProviders.length === 0 ? (
            <div
              className="rounded-lg border p-3 text-sm"
              style={{
                borderColor: 'var(--color-border-subtle)',
                color: 'var(--color-text-secondary)',
              }}
            >
              {t('runtimeProvider.providers.noMatches')}
            </div>
          ) : null}

          {!useDirectoryRows && !state.loading && state.providers.length === 0 ? (
            <div
              className="rounded-lg border p-3 text-sm"
              style={{
                borderColor: 'var(--color-border-subtle)',
                color: 'var(--color-text-secondary)',
              }}
            >
              {t('runtimeProvider.providers.noneReported')}
            </div>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}
