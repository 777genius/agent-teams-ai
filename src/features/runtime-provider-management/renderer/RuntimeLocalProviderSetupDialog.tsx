import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import {
  buildProjectPathOptions,
  findProjectPathProjectByPath,
  isDeletedProjectPathSelection,
} from '@renderer/components/team/dialogs/projectPathOptions';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Combobox } from '@renderer/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { normalizePathForMatching } from '@renderer/utils/pathNormalize';
import {
  AlertTriangle,
  ArrowLeft,
  Box,
  CheckCircle2,
  FolderOpen,
  Globe2,
  Info,
  Loader2,
  Pencil,
  Plus,
  RefreshCcw,
  Server,
} from 'lucide-react';

import {
  isPrivateNetworkRuntimeLocalProviderUrl,
  RUNTIME_LOCAL_PROVIDER_PRESETS,
} from '../core/domain';

import { LocalProviderBrandIcon } from './ui/LocalProviderBrandIcon';

import type {
  RuntimeLocalProviderConfigurationDto,
  RuntimeLocalProviderListEntryDto,
  RuntimeLocalProviderPresetIdDto,
  RuntimeLocalProviderProbeDto,
  RuntimeLocalProviderScopeDto,
  RuntimeProviderManagementErrorCodeDto,
} from '../contracts';
import type { ProjectPathProject } from '@renderer/components/team/dialogs/projectPathProjects';
import type { ComboboxOption } from '@renderer/components/ui/combobox';
import type { JSX, ReactNode } from 'react';

const SERVER_START_GUIDANCE: Record<RuntimeLocalProviderPresetIdDto, string> = {
  ollama:
    'Make sure Ollama is running and at least one model has been pulled locally. Agent Teams tool use needs an effective 16K-32K context; Ollama defaults to 4K unless configured separately.',
  'lm-studio': 'In LM Studio, load a model, open Developer > Local Server, and start the server.',
  'atomic-chat': 'Open Atomic Chat, load a model, and start its local API server.',
  'llama.cpp': 'Start llama-server with a model loaded. The default port for this setup is 8080.',
  custom:
    'Start an OpenAI-compatible API on this computer or your local network with a working /v1/models endpoint.',
};

type SetupErrorScope = 'server' | 'project' | 'model' | 'setup';

interface SetupErrorState {
  readonly scope: SetupErrorScope;
  readonly message: string;
}

const getProjectName = (projectPath: string): string =>
  projectPath.split(/[/\\]/).filter(Boolean).pop() ?? projectPath;

const getProjectConfigPath = (projectPath: string): string => {
  const separator = projectPath.includes('\\') && !projectPath.includes('/') ? '\\' : '/';
  return `${projectPath.replace(/[/\\]+$/, '')}${separator}opencode.json`;
};

const splitConfigPath = (configPath: string): { directory: string; filename: string } => {
  const separatorIndex = Math.max(configPath.lastIndexOf('/'), configPath.lastIndexOf('\\'));
  return separatorIndex < 0
    ? { directory: '', filename: configPath }
    : {
        directory: configPath.slice(0, separatorIndex + 1),
        filename: configPath.slice(separatorIndex + 1),
      };
};

const getLocalModelVerificationCwd = (
  configuration: RuntimeLocalProviderConfigurationDto,
  targetProjectPath: string | null
): string => {
  const projectPath = targetProjectPath?.trim();
  if (projectPath) return projectPath;
  const configPath = configuration.configPath.trim();
  const separatorIndex = Math.max(configPath.lastIndexOf('/'), configPath.lastIndexOf('\\'));
  return separatorIndex > 0 ? configPath.slice(0, separatorIndex) : configPath;
};

const getLocalModelReadinessError = (
  readiness: Awaited<ReturnType<typeof api.teams.prepareProvisioning>>,
  modelRoute: string
): string => {
  const modelIssue = readiness.issues?.find(
    (issue) =>
      issue.severity === 'blocking' && (issue.modelId === modelRoute || issue.scope === 'provider')
  );
  return (
    modelIssue?.message ||
    readiness.message ||
    'The model is configured, but it is not ready for Agent Teams launch.'
  );
};

const getFriendlyVerificationError = (
  errorCode: RuntimeProviderManagementErrorCodeDto,
  serverName: string
): string => {
  switch (errorCode) {
    case 'runtime-missing':
      return 'OpenCode is not available yet. Install or repair OpenCode, then retry verification.';
    case 'runtime-misconfigured':
    case 'runtime-unhealthy':
      return 'OpenCode is not ready to run this model. Reopen provider settings, check the OpenCode status, then retry.';
    case 'provider-missing':
      return `${serverName} is saved, but OpenCode could not load this provider. Reopen provider settings, then retry.`;
    case 'auth-required':
    case 'auth-failed':
      return `${serverName} rejected the request. Check the local server access settings, then retry.`;
    case 'model-missing':
      return `The selected model is no longer available in ${serverName}. Load it again, refresh models, then retry.`;
    case 'model-test-failed':
      return `OpenCode could not get a response from ${serverName}. Make sure the server and selected model are running, then retry.`;
    default:
      return 'OpenCode could not verify the local model. Check the server, then retry.';
  }
};

interface SetupStepProps {
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly complete: boolean;
  readonly icon: ReactNode;
  readonly children: ReactNode;
}

const SetupStep = ({
  number,
  title,
  description,
  complete,
  icon,
  children,
}: SetupStepProps): JSX.Element => (
  <section
    aria-labelledby={`runtime-local-provider-step-${number}`}
    data-testid={`runtime-local-provider-step-${number}`}
    className="grid gap-4 border-b border-white/[0.07] py-4 last:border-b-0 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-6"
  >
    <div className="flex items-start gap-3 sm:pr-2">
      <div
        className={`relative flex size-9 shrink-0 items-center justify-center rounded-lg ${
          complete
            ? 'bg-emerald-400/[0.09] text-emerald-300'
            : 'bg-indigo-400/[0.08] text-indigo-300'
        }`}
        aria-label={complete ? `Step ${number} complete` : `Step ${number}`}
      >
        {icon}
        <span
          className={`absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full text-[9px] font-semibold ${
            complete
              ? 'bg-emerald-400 text-slate-950'
              : 'bg-[var(--color-surface-raised)] text-[var(--color-text-secondary)] ring-1 ring-white/15'
          }`}
          aria-hidden="true"
        >
          {complete ? <CheckCircle2 className="size-2.5" /> : number}
        </span>
      </div>
      <div className="min-w-0">
        <h3
          id={`runtime-local-provider-step-${number}`}
          className="text-sm font-semibold text-[var(--color-text)]"
        >
          {title}
        </h3>
        <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
          {description}
        </p>
      </div>
    </div>
    <div className="min-w-0 space-y-3">{children}</div>
  </section>
);

interface SetupProgressProps {
  readonly serverComplete: boolean;
  readonly scopeComplete: boolean;
  readonly modelComplete: boolean;
}

const SetupProgress = ({
  serverComplete,
  scopeComplete,
  modelComplete,
}: SetupProgressProps): JSX.Element => {
  const steps = [
    { number: 1, label: 'Server', complete: serverComplete },
    { number: 2, label: 'Scope', complete: scopeComplete },
    { number: 3, label: 'Model', complete: modelComplete },
  ];
  const activeStep = !serverComplete ? 1 : !scopeComplete ? 2 : 3;

  return (
    <ol aria-label="Local model setup progress" className="grid grid-cols-3 px-2">
      {steps.map((step, index) => {
        const active = step.number === activeStep;
        return (
          <li key={step.label} className="relative flex flex-col items-center gap-1.5">
            {index > 0 ? (
              <span
                aria-hidden="true"
                className={`absolute right-1/2 top-2.5 h-px w-full ${
                  steps[index - 1]?.complete ? 'bg-emerald-400/45' : 'bg-white/10'
                }`}
              />
            ) : null}
            <span
              className={`relative z-10 flex size-5 items-center justify-center rounded-full text-[9px] font-semibold ring-1 ${
                step.complete
                  ? 'bg-emerald-400 text-slate-950 ring-emerald-300/50'
                  : active
                    ? 'bg-indigo-400/20 text-indigo-200 shadow-[0_0_16px_rgba(129,140,248,0.35)] ring-indigo-300/70'
                    : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] ring-white/15'
              }`}
              aria-label={step.complete ? `${step.label} complete` : step.label}
            >
              {step.complete ? <CheckCircle2 className="size-3" aria-hidden="true" /> : step.number}
            </span>
            <span
              className={`text-[10px] font-medium ${
                step.complete || active
                  ? 'text-[var(--color-text-secondary)]'
                  : 'text-[var(--color-text-muted)]'
              }`}
            >
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
};

const InlineError = ({ message }: { readonly message: string }): JSX.Element => (
  <div
    role="alert"
    className="flex items-start gap-2 rounded-r-md border-l-2 border-red-400/70 bg-red-400/[0.06] px-3 py-2.5 text-xs text-red-200"
  >
    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
    <span>{message}</span>
  </div>
);

interface ProviderScopeSelectorProps {
  readonly value: RuntimeLocalProviderScopeDto;
  readonly disabled?: boolean;
  readonly onChange: (scope: RuntimeLocalProviderScopeDto) => void;
}

const ProviderScopeSelector = ({
  value,
  disabled = false,
  onChange,
}: ProviderScopeSelectorProps): JSX.Element => (
  <div
    role="radiogroup"
    aria-label="Available for"
    className="inline-grid grid-cols-2 gap-1 justify-self-start rounded-xl bg-white/[0.035] p-1 ring-1 ring-inset ring-white/[0.08]"
  >
    {(
      [
        { value: 'global', label: 'All projects', icon: Globe2 },
        { value: 'project', label: 'Select project', icon: FolderOpen },
      ] as const
    ).map((option) => {
      const active = value === option.value;
      const OptionIcon = option.icon;
      return (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={active}
          disabled={disabled}
          className={`flex h-8 items-center justify-center gap-1.5 rounded-lg px-3.5 text-xs font-medium transition-all ${
            active
              ? 'bg-gradient-to-r from-indigo-400/20 to-sky-400/10 text-indigo-100 shadow-[0_4px_14px_rgba(79,70,229,0.12)] ring-1 ring-inset ring-indigo-300/15'
              : 'text-[var(--color-text-muted)] hover:bg-white/[0.04] hover:text-[var(--color-text-secondary)]'
          } disabled:cursor-not-allowed disabled:opacity-50`}
          onClick={() => onChange(option.value)}
        >
          <OptionIcon className="size-3.5" aria-hidden="true" />
          {option.label}
        </button>
      );
    })}
  </div>
);

interface RuntimeLocalProviderSetupDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectPath: string | null;
  readonly projects: readonly ProjectPathProject[];
  readonly onProjectPathChange: (projectPath: string | null) => void;
  readonly onConfigured: () => Promise<void> | void;
}

type SetupPhase = 'idle' | 'probing' | 'configuring' | 'refreshing' | 'verifying' | 'done';
type ProviderView = 'loading' | 'list' | 'editor';

export const RuntimeLocalProviderSetupDialog = ({
  open,
  onOpenChange,
  projectPath,
  projects,
  onProjectPathChange,
  onConfigured,
}: RuntimeLocalProviderSetupDialogProps): JSX.Element => {
  const [selectedPresetId, setSelectedPresetId] =
    useState<RuntimeLocalProviderPresetIdDto>('ollama');
  const [providerId, setProviderId] = useState('ollama');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:11434/v1');
  const [scanLoading, setScanLoading] = useState(false);
  const [projectPickerLoading, setProjectPickerLoading] = useState(false);
  const [folderSelectedProjectPath, setFolderSelectedProjectPath] = useState<string | null>(null);
  const [scanProbes, setScanProbes] = useState<readonly RuntimeLocalProviderProbeDto[]>([]);
  const [probe, setProbe] = useState<RuntimeLocalProviderProbeDto | null>(null);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [configurationScope, setConfigurationScope] =
    useState<RuntimeLocalProviderScopeDto>('global');
  const [setAsDefault, setSetAsDefault] = useState(true);
  const [setAsSmallModel, setSetAsSmallModel] = useState(true);
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false);
  const [phase, setPhase] = useState<SetupPhase>('idle');
  const [error, setError] = useState<SetupErrorState | null>(null);
  const [savedConfiguration, setSavedConfiguration] =
    useState<RuntimeLocalProviderConfigurationDto | null>(null);
  const [savedProjectPath, setSavedProjectPath] = useState<string | null>(null);
  const [savedSummary, setSavedSummary] = useState<string | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [verificationPassed, setVerificationPassed] = useState(false);
  const [providerView, setProviderView] = useState<ProviderView>('editor');
  const [configuredProviders, setConfiguredProviders] = useState<
    readonly RuntimeLocalProviderListEntryDto[]
  >([]);
  const [providerListLoading, setProviderListLoading] = useState(false);
  const [providerListError, setProviderListError] = useState<string | null>(null);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const selectionTouchedRef = useRef(false);
  const dialogSessionRef = useRef(0);
  const providerViewRef = useRef<ProviderView>('editor');
  const providerListRequestRef = useRef(0);

  const selectedPreset = useMemo(
    () =>
      RUNTIME_LOCAL_PROVIDER_PRESETS.find((preset) => preset.id === selectedPresetId) ??
      RUNTIME_LOCAL_PROVIDER_PRESETS[0],
    [selectedPresetId]
  );
  const busy =
    phase === 'probing' ||
    phase === 'configuring' ||
    phase === 'refreshing' ||
    phase === 'verifying';
  const closeBlocked = phase === 'configuring' || projectPickerLoading;
  const setupLocked = busy || Boolean(savedConfiguration);
  const detectedProbes = scanProbes.filter((candidate) => candidate.state === 'available');
  const privateNetworkUrl = isPrivateNetworkRuntimeLocalProviderUrl(baseUrl);
  const projectConfigPath = projectPath ? getProjectConfigPath(projectPath) : null;
  const expectedConfigPath =
    configurationScope === 'global' ? '~/.config/opencode/opencode.json' : projectConfigPath;
  const displayedConfigPath = savedConfiguration?.configPath ?? expectedConfigPath;
  const displayedConfigPathParts = displayedConfigPath
    ? splitConfigPath(displayedConfigPath)
    : null;
  const projectSelectedFromFolder = Boolean(
    projectPath &&
    folderSelectedProjectPath &&
    normalizePathForMatching(projectPath) === normalizePathForMatching(folderSelectedProjectPath)
  );
  const projectsForOptions = useMemo(
    () =>
      projectSelectedFromFolder && projectPath
        ? projects.map((project) =>
            normalizePathForMatching(project.path) === normalizePathForMatching(projectPath)
              ? { ...project, filesystemState: 'available' as const }
              : project
          )
        : [...projects],
    [projectPath, projectSelectedFromFolder, projects]
  );
  const selectedProjectDeleted = Boolean(
    projectPath && isDeletedProjectPathSelection(projectsForOptions, projectPath)
  );
  const projectComplete = Boolean(projectPath && !selectedProjectDeleted);
  const availabilityComplete = configurationScope === 'global' || projectComplete;
  const projectOptions = useMemo<ComboboxOption[]>(() => {
    const options = buildProjectPathOptions(projectsForOptions, projectPath ?? undefined);
    if (projectPath && !findProjectPathProjectByPath(projectsForOptions, projectPath)) {
      options.unshift({
        value: projectPath,
        label: getProjectName(projectPath),
        description: projectPath,
      });
    }
    return options;
  }, [projectPath, projectsForOptions]);
  const serverConnected = probe?.state === 'available';
  const serverHasModels = serverConnected && (probe?.models.length ?? 0) > 0;
  const scopeProgressComplete = serverConnected && availabilityComplete;
  const readyToSave = Boolean(availabilityComplete && selectedModelId && serverHasModels);

  const showProviderView = useCallback((view: ProviderView): void => {
    providerViewRef.current = view;
    setProviderView(view);
  }, []);

  const loadConfiguredProviders = useCallback(
    async (
      scope: RuntimeLocalProviderScopeDto,
      targetProjectPath: string | null,
      options: { readonly showListAfterLoad?: boolean; readonly sessionId?: number } = {}
    ): Promise<void> => {
      const sessionId = options.sessionId ?? dialogSessionRef.current;
      const requestId = ++providerListRequestRef.current;
      setProviderListLoading(true);
      setProviderListError(null);
      try {
        const response = await api.runtimeProviderManagement.listLocalProviders({
          runtimeId: 'opencode',
          scope,
          projectPath: scope === 'project' ? targetProjectPath : null,
        });
        if (
          dialogSessionRef.current !== sessionId ||
          providerListRequestRef.current !== requestId
        ) {
          return;
        }
        if (response.error) {
          setConfiguredProviders([]);
          setProviderListError(response.error.message);
        } else {
          const providers = response.providers ?? [];
          setConfiguredProviders(providers);
          if (options.showListAfterLoad) {
            showProviderView(providers.length > 0 ? 'list' : 'editor');
            return;
          }
        }
        if (options.showListAfterLoad) showProviderView('list');
      } catch {
        if (
          dialogSessionRef.current !== sessionId ||
          providerListRequestRef.current !== requestId
        ) {
          return;
        }
        setConfiguredProviders([]);
        setProviderListError(
          scope === 'global'
            ? 'Could not load the local providers available to all projects.'
            : 'Could not load the local providers saved in this project.'
        );
        if (options.showListAfterLoad) showProviderView('list');
      } finally {
        if (
          dialogSessionRef.current === sessionId &&
          providerListRequestRef.current === requestId
        ) {
          setProviderListLoading(false);
        }
      }
    },
    [showProviderView]
  );

  const nextAction = useMemo(() => {
    if (phase === 'probing') return 'Testing the local server connection...';
    if (phase === 'configuring') {
      return configurationScope === 'global'
        ? 'Writing the global OpenCode settings...'
        : 'Writing the project settings...';
    }
    if (phase === 'refreshing') return 'Refreshing the OpenCode provider catalog...';
    if (phase === 'verifying') {
      return 'Verifying model tools and runtime capacity for Agent Teams...';
    }
    if (savedConfiguration && verificationError) {
      return 'Settings are saved. Retry the check now, or close and fix the server later.';
    }
    if (savedConfiguration && verificationPassed) {
      return 'Your local model is ready for Agent Teams launch.';
    }
    if (scanLoading) return 'Looking for local model servers on this computer...';
    if (!serverConnected) {
      return `Start ${selectedPreset.displayName}, then test the connection.`;
    }
    if (!serverHasModels) {
      return `Load a model in ${selectedPreset.displayName}, then refresh the model list.`;
    }
    if (configurationScope === 'project' && !projectPath) {
      return 'Choose the project that should use this model.';
    }
    if (configurationScope === 'project' && selectedProjectDeleted) {
      return 'Choose an available project or folder.';
    }
    if (!selectedModelId) return 'Choose a local model.';
    return 'Everything is ready. Save the setup and run the final check.';
  }, [
    phase,
    configurationScope,
    projectPath,
    savedConfiguration,
    scanLoading,
    selectedModelId,
    selectedProjectDeleted,
    selectedPreset.displayName,
    serverConnected,
    serverHasModels,
    verificationError,
    verificationPassed,
  ]);

  useEffect(() => {
    const sessionId = ++dialogSessionRef.current;
    if (!open) {
      return;
    }
    let cancelled = false;
    selectionTouchedRef.current = false;
    setSelectedPresetId('ollama');
    setProviderId('ollama');
    setBaseUrl('http://127.0.0.1:11434/v1');
    setScanProbes([]);
    setProbe(null);
    setSelectedModelId('');
    setConfigurationScope('global');
    setSetAsDefault(true);
    setProjectPickerLoading(false);
    setFolderSelectedProjectPath(null);
    setPhase('idle');
    setError(null);
    setSavedConfiguration(null);
    setSavedProjectPath(null);
    setSavedSummary(null);
    setRefreshWarning(null);
    setVerificationError(null);
    setVerificationPassed(false);
    showProviderView('loading');
    setConfiguredProviders([]);
    setProviderListLoading(false);
    setProviderListError(null);
    setEditingProviderId(null);
    setScanLoading(true);
    void api.runtimeProviderManagement
      .scanLocalProviders({ runtimeId: 'opencode' })
      .then((response) => {
        if (cancelled || dialogSessionRef.current !== sessionId) return;
        if (response.error) {
          setError({ scope: 'server', message: response.error.message });
          return;
        }
        const probes = response.probes ?? [];
        setScanProbes(probes);
        const detected = probes.find((candidate) => candidate.state === 'available');
        if (!detected || selectionTouchedRef.current) {
          return;
        }
        setSelectedPresetId(detected.preset.id);
        setProviderId(detected.providerId);
        setBaseUrl(detected.baseUrl);
        setProbe(detected);
        setSelectedModelId(detected.models[0]?.id ?? '');
      })
      .catch(() => {
        if (!cancelled && dialogSessionRef.current === sessionId) {
          setError({
            scope: 'server',
            message:
              'Could not scan local model servers. Choose your server app and test its address manually.',
          });
        }
      })
      .finally(() => {
        if (!cancelled && dialogSessionRef.current === sessionId) setScanLoading(false);
      });
    return () => {
      cancelled = true;
      if (dialogSessionRef.current === sessionId) {
        dialogSessionRef.current += 1;
      }
    };
  }, [open, showProviderView]);

  useEffect(() => {
    if (!open) return;
    const targetProjectPath = projectPath?.trim() || null;
    if (configurationScope === 'project' && !targetProjectPath) {
      setConfiguredProviders([]);
      setProviderListError(null);
      setProviderListLoading(false);
      if (providerViewRef.current === 'loading') showProviderView('list');
      return;
    }
    const showListAfterLoad = providerViewRef.current === 'loading';
    void loadConfiguredProviders(configurationScope, targetProjectPath, {
      showListAfterLoad,
      sessionId: dialogSessionRef.current,
    });
  }, [configurationScope, loadConfiguredProviders, open, projectPath, showProviderView]);

  const resetProbe = (): void => {
    setProbe(null);
    setSelectedModelId('');
    setError(null);
    setSavedConfiguration(null);
    setSavedProjectPath(null);
    setSavedSummary(null);
    setRefreshWarning(null);
    setVerificationError(null);
    setVerificationPassed(false);
    setPhase('idle');
  };

  const selectPreset = (presetId: RuntimeLocalProviderPresetIdDto): void => {
    selectionTouchedRef.current = true;
    const preset = RUNTIME_LOCAL_PROVIDER_PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    setSelectedPresetId(preset.id);
    setProviderId(preset.providerId);
    setBaseUrl(preset.defaultBaseUrl);
    setAllowPrivateNetwork(false);
    const scanned = scanProbes.find((candidate) => candidate.preset.id === preset.id) ?? null;
    setProbe(scanned?.state === 'available' ? scanned : null);
    setSelectedModelId(scanned?.models[0]?.id ?? '');
    setError(null);
    setSavedConfiguration(null);
    setSavedProjectPath(null);
    setSavedSummary(null);
    setRefreshWarning(null);
    setVerificationError(null);
    setVerificationPassed(false);
    setPhase('idle');
  };

  const testConnection = async (): Promise<void> => {
    selectionTouchedRef.current = true;
    const sessionId = dialogSessionRef.current;
    setPhase('probing');
    setError(null);
    setVerificationError(null);
    setVerificationPassed(false);
    try {
      const response = await api.runtimeProviderManagement.probeLocalProvider({
        runtimeId: 'opencode',
        presetId: selectedPresetId,
        baseUrl,
        providerId,
        allowPrivateNetwork,
      });
      if (dialogSessionRef.current !== sessionId) return;
      if (response.error) {
        setError({ scope: 'server', message: response.error.message });
        setProbe(null);
        return;
      }
      const nextProbe = response.probe ?? null;
      setProbe(nextProbe);
      setSelectedModelId(nextProbe?.models[0]?.id ?? '');
      if (!nextProbe || nextProbe.state !== 'available') {
        setError({
          scope: 'server',
          message: nextProbe?.message ?? 'Could not reach the local server.',
        });
      }
    } catch {
      if (dialogSessionRef.current === sessionId) {
        setError({ scope: 'server', message: 'Could not test the local server.' });
        setProbe(null);
      }
    } finally {
      if (dialogSessionRef.current === sessionId) setPhase('idle');
    }
  };

  const chooseProjectFolder = async (): Promise<void> => {
    const sessionId = dialogSessionRef.current;
    setProjectPickerLoading(true);
    setError(null);
    try {
      const [selectedPath] = await api.config.selectFolders();
      if (selectedPath && dialogSessionRef.current === sessionId) {
        setFolderSelectedProjectPath(selectedPath);
        onProjectPathChange(selectedPath);
      }
    } catch {
      if (dialogSessionRef.current === sessionId) {
        setError({ scope: 'project', message: 'Could not open the project folder picker.' });
      }
    } finally {
      if (dialogSessionRef.current === sessionId) setProjectPickerLoading(false);
    }
  };

  const verifySavedModel = async (
    configuration: RuntimeLocalProviderConfigurationDto,
    targetProjectPath: string | null,
    sessionId = dialogSessionRef.current
  ): Promise<void> => {
    if (dialogSessionRef.current !== sessionId) return;
    setPhase('verifying');
    setVerificationError(null);
    setVerificationPassed(false);
    try {
      // Check model/runtime capacity before asking OpenCode to execute a model turn.
      // This rejects known-incompatible local models from metadata in milliseconds
      // instead of waiting for a doomed execution probe to time out.
      const readiness = await api.teams.prepareProvisioning(
        getLocalModelVerificationCwd(configuration, targetProjectPath),
        'opencode',
        ['opencode'],
        [configuration.modelRoute],
        false,
        'deep'
      );
      if (dialogSessionRef.current !== sessionId) return;
      if (!readiness.ready) {
        setVerificationError(getLocalModelReadinessError(readiness, configuration.modelRoute));
        return;
      }
      const readinessWarning =
        readiness.issues?.find(
          (issue) =>
            issue.severity === 'warning' &&
            (issue.modelId === configuration.modelRoute || issue.scope === 'provider')
        )?.message ?? readiness.warnings?.[0];
      if (readinessWarning) {
        setRefreshWarning((current) =>
          current ? `${current} ${readinessWarning}` : readinessWarning
        );
      }

      const runVerification = () =>
        api.runtimeProviderManagement.testModel({
          runtimeId: 'opencode',
          projectPath: targetProjectPath,
          providerId: configuration.providerId,
          modelId: configuration.modelRoute,
        });
      let verification = await runVerification();
      if (
        verification.error &&
        (verification.error.code === 'provider-missing' ||
          verification.error.code === 'model-missing')
      ) {
        // OpenCode can briefly serve a stale provider catalog immediately
        // after opencode.json changes. Refresh once and absorb that propagation
        // delay instead of asking the user to press Retry for a healthy model.
        try {
          await onConfigured();
        } catch {
          // The verification retry below remains the source of truth.
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 750));
        if (dialogSessionRef.current !== sessionId) return;
        verification = await runVerification();
      }
      if (dialogSessionRef.current !== sessionId) return;
      if (verification.error || !verification.result?.ok) {
        setVerificationError(
          verification.error
            ? getFriendlyVerificationError(verification.error.code, selectedPreset.displayName)
            : verification.result?.message && verification.result.message.length <= 240
              ? verification.result.message
              : 'OpenCode could not complete a model request. Check the local server, then retry.'
        );
        return;
      }
      setVerificationPassed(true);
    } catch {
      if (dialogSessionRef.current === sessionId) {
        setVerificationError('OpenCode could not complete a model request.');
      }
    } finally {
      if (dialogSessionRef.current === sessionId) setPhase('done');
    }
  };

  const configureAndVerify = async (): Promise<void> => {
    if (configurationScope === 'project' && !projectPath) {
      setError({
        scope: 'project',
        message: 'Choose the project that should use this local model.',
      });
      return;
    }
    if (!selectedModelId) {
      setError({
        scope: 'model',
        message: 'Connect the local server and choose a model before saving.',
      });
      return;
    }
    const sessionId = dialogSessionRef.current;
    setPhase('configuring');
    setError(null);
    setSavedSummary(null);
    setRefreshWarning(null);
    setVerificationError(null);
    setVerificationPassed(false);
    try {
      const response = await api.runtimeProviderManagement.configureLocalProvider({
        runtimeId: 'opencode',
        scope: configurationScope,
        projectPath: configurationScope === 'project' ? projectPath : null,
        presetId: selectedPresetId,
        baseUrl,
        providerId,
        defaultModelId: selectedModelId,
        setAsDefault,
        setAsSmallModel,
        allowPrivateNetwork,
      });
      if (dialogSessionRef.current !== sessionId) return;
      if (response.error || !response.configuration) {
        setError({
          scope: 'setup',
          message: response.error?.message ?? 'Could not save the local model setup.',
        });
        setPhase('idle');
        return;
      }

      const configuration = response.configuration;
      setSavedConfiguration(configuration);
      setSavedProjectPath(configurationScope === 'project' ? projectPath : null);
      setConfiguredProviders((current) => {
        const nextEntry: RuntimeLocalProviderListEntryDto = {
          preset: selectedPreset,
          providerId: configuration.providerId,
          baseUrl: configuration.baseUrl,
          configuredModelIds: configuration.modelIds,
          defaultModelId: configuration.defaultModelId,
          isDefault: setAsDefault,
          state: probe?.state ?? 'available',
          liveModels: probe?.models ?? [],
          latencyMs: probe?.latencyMs ?? null,
          message: probe?.message ?? 'Saved.',
        };
        const withoutUpdatedProvider = current
          .filter((entry) => entry.providerId !== configuration.providerId)
          .map((entry) =>
            setAsDefault && entry.isDefault ? { ...entry, isDefault: false } : entry
          );
        return [nextEntry, ...withoutUpdatedProvider];
      });
      setSavedSummary(
        `${selectedPreset.displayName} was saved ${configurationScope === 'global' ? 'for all projects' : 'for this project'} with ${response.configuration.modelIds.length} model${response.configuration.modelIds.length === 1 ? '' : 's'}. ${setAsDefault ? `It is now the ${configurationScope === 'global' ? 'global' : 'project'} default.` : `Existing ${configurationScope === 'global' ? 'global' : 'project'} defaults were preserved.`}`
      );
      setPhase('refreshing');
      try {
        await onConfigured();
      } catch {
        if (dialogSessionRef.current === sessionId) {
          setRefreshWarning(
            'The setup is saved, but the provider list did not refresh automatically. Reopen provider settings if the model is not visible.'
          );
        }
      }
      if (dialogSessionRef.current !== sessionId) return;
      await verifySavedModel(
        configuration,
        configurationScope === 'project' ? projectPath : null,
        sessionId
      );
    } catch {
      if (dialogSessionRef.current === sessionId) {
        setError({ scope: 'setup', message: 'Could not save the local model setup.' });
        setPhase('idle');
      }
    }
  };

  const editSetup = (): void => {
    setSavedConfiguration(null);
    setSavedProjectPath(null);
    setSavedSummary(null);
    setRefreshWarning(null);
    setVerificationError(null);
    setVerificationPassed(false);
    setError(null);
    setPhase('idle');
  };

  const changeConfigurationScope = (scope: RuntimeLocalProviderScopeDto): void => {
    if (scope === configurationScope || setupLocked) return;
    editSetup();
    setConfigurationScope(scope);
    setEditingProviderId(null);
    setConfiguredProviders([]);
    setProviderListError(null);
    setSetAsDefault(true);
    showProviderView('loading');
  };

  const beginAddProvider = (): void => {
    const configuredProviderIds = new Set(configuredProviders.map((entry) => entry.providerId));
    const nextPreset =
      RUNTIME_LOCAL_PROVIDER_PRESETS.find(
        (candidate) => candidate.id !== 'custom' && !configuredProviderIds.has(candidate.providerId)
      ) ?? RUNTIME_LOCAL_PROVIDER_PRESETS.find((candidate) => candidate.id === 'custom');
    if (nextPreset) selectPreset(nextPreset.id);
    setEditingProviderId(null);
    setSetAsDefault(configuredProviders.length === 0);
    setSetAsSmallModel(true);
    showProviderView('editor');
  };

  const beginEditProvider = (entry: RuntimeLocalProviderListEntryDto): void => {
    selectionTouchedRef.current = true;
    editSetup();
    setSelectedPresetId(entry.preset.id);
    setProviderId(entry.providerId);
    setBaseUrl(entry.baseUrl);
    // A previously saved private-network address was already approved by the user.
    setAllowPrivateNetwork(isPrivateNetworkRuntimeLocalProviderUrl(entry.baseUrl));
    setProbe({
      preset: entry.preset,
      providerId: entry.providerId,
      baseUrl: entry.baseUrl,
      state: entry.state,
      models: entry.liveModels,
      latencyMs: entry.latencyMs,
      message: entry.message,
    });
    setSelectedModelId(
      entry.liveModels.some((model) => model.id === entry.defaultModelId)
        ? (entry.defaultModelId ?? '')
        : (entry.liveModels[0]?.id ?? '')
    );
    setSetAsDefault(entry.isDefault);
    setEditingProviderId(entry.providerId);
    showProviderView('editor');
  };

  const showProviderList = (): void => {
    showProviderView('list');
    if (configurationScope === 'global' || projectPath) {
      void loadConfiguredProviders(configurationScope, projectPath, {
        sessionId: dialogSessionRef.current,
      });
    }
  };

  const requestClose = (): void => {
    if (closeBlocked) return;
    dialogSessionRef.current += 1;
    onOpenChange(false);
  };
  const runningProviderCount = configuredProviders.filter(
    (provider) => provider.state === 'available'
  ).length;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          onOpenChange(true);
          return;
        }
        requestClose();
      }}
    >
      <DialogContent
        closeDisabled={closeBlocked}
        className="max-h-[min(94vh,760px)] max-w-4xl grid-rows-[minmax(0,1fr)_auto] gap-0 overflow-hidden p-0"
        onEscapeKeyDown={(event) => {
          if (closeBlocked) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (closeBlocked) event.preventDefault();
        }}
      >
        <div className="min-h-0 overflow-y-auto px-6 pb-1 pt-5 sm:px-7">
          <DialogHeader className="pr-10">
            <DialogTitle>
              {providerView === 'editor'
                ? editingProviderId
                  ? `Edit ${selectedPreset.displayName}`
                  : 'Add a local provider'
                : 'Local providers'}
            </DialogTitle>
            <DialogDescription className="max-w-2xl">
              {providerView === 'editor'
                ? 'Connect a local server, choose where it is available, and verify one model through OpenCode.'
                : `See every local server available ${configurationScope === 'global' ? 'to all projects' : 'to the selected project'}, then add or edit providers in one place.`}
            </DialogDescription>
          </DialogHeader>

          {providerView !== 'editor' ? (
            <div
              className="mt-5 space-y-5"
              data-testid="runtime-local-provider-manager"
              aria-busy={providerListLoading || projectPickerLoading}
            >
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-center">
                <Label className="text-xs text-[var(--color-text-secondary)]">Available for</Label>
                <ProviderScopeSelector
                  value={configurationScope}
                  disabled={providerListLoading || projectPickerLoading}
                  onChange={changeConfigurationScope}
                />
                {configurationScope === 'project' ? (
                  <>
                    <span className="hidden sm:block" aria-hidden="true" />
                    <div className="flex min-w-0 flex-col gap-2.5 sm:flex-row">
                      <Combobox
                        id="runtime-local-provider-manager-project"
                        value={projectPath ?? ''}
                        options={projectOptions}
                        placeholder="Choose a project"
                        searchPlaceholder="Search projects..."
                        emptyMessage="No matching projects."
                        className="h-9 min-w-0 flex-1 rounded-lg bg-white/[0.015] px-3.5 shadow-none"
                        disabled={projectPickerLoading || projectOptions.length === 0}
                        onValueChange={(value) => {
                          setProviderListError(null);
                          setFolderSelectedProjectPath(null);
                          onProjectPathChange(value);
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 shrink-0 rounded-lg bg-white/[0.015] px-4"
                        disabled={projectPickerLoading}
                        onClick={() => void chooseProjectFolder()}
                      >
                        {projectPickerLoading ? (
                          <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                        ) : (
                          <FolderOpen className="mr-1.5 size-3.5" />
                        )}
                        Choose folder
                      </Button>
                    </div>
                  </>
                ) : null}
                <span className="hidden sm:block" aria-hidden="true" />
                <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                  <Info className="mt-0.5 size-3 shrink-0 opacity-70" aria-hidden="true" />
                  {configurationScope === 'global'
                    ? 'Saved in your global OpenCode config and available in every project. A project can still override it.'
                    : "Saved only in the selected project's OpenCode config."}
                </p>
              </div>

              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-[var(--color-text)]">
                      Configured providers
                    </h3>
                    <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                      {configuredProviders.length === 0
                        ? configurationScope === 'global'
                          ? 'No local servers are available to all projects yet.'
                          : 'No local servers have been added to this project yet.'
                        : runningProviderCount === 0
                          ? `${configuredProviders.length} local provider${configuredProviders.length === 1 ? '' : 's'} configured, but offline. Start the server before launching a team.`
                          : runningProviderCount === configuredProviders.length
                            ? `${runningProviderCount} local provider${runningProviderCount === 1 ? '' : 's'} running and available for model selection.`
                            : `${runningProviderCount} of ${configuredProviders.length} local providers running. Offline providers remain configured but cannot launch.`}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    className="gap-1.5"
                    disabled={!availabilityComplete || providerListLoading}
                    onClick={beginAddProvider}
                  >
                    <Plus className="size-3.5" />
                    Add provider
                  </Button>
                </div>

                {providerListError ? <InlineError message={providerListError} /> : null}
                {providerListLoading || providerView === 'loading' ? (
                  <div className="flex items-center gap-2 border-t border-white/[0.07] py-6 text-xs text-[var(--color-text-muted)]">
                    <Loader2 className="size-4 animate-spin" />
                    Checking configured local providers...
                  </div>
                ) : configuredProviders.length > 0 ? (
                  <div className="divide-y divide-white/[0.07] border-t border-white/[0.07]">
                    {configuredProviders.map((entry) => (
                      <div
                        key={entry.providerId}
                        data-testid={`configured-local-provider-${entry.providerId}`}
                        className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center"
                      >
                        <LocalProviderBrandIcon
                          presetId={entry.preset.id}
                          displayName={entry.preset.displayName}
                          size="large"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-[var(--color-text)]">
                              {entry.preset.displayName}
                            </span>
                            <span
                              className={`inline-flex items-center gap-1 text-[10px] font-medium ${
                                entry.state === 'available' ? 'text-emerald-300' : 'text-amber-300'
                              }`}
                            >
                              <span
                                className={`size-1.5 rounded-full ${
                                  entry.state === 'available' ? 'bg-emerald-400' : 'bg-amber-300'
                                }`}
                              />
                              {entry.state === 'available' ? 'Running' : 'Offline'}
                            </span>
                            {entry.isDefault ? (
                              <span className="rounded-full bg-indigo-400/10 px-2 py-0.5 text-[9px] font-medium text-indigo-200">
                                {configurationScope === 'global'
                                  ? 'Global default'
                                  : 'Project default'}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-[var(--color-text-muted)]">
                            <span>{entry.providerId}</span>
                            <span className="truncate">{entry.baseUrl}</span>
                            <span>
                              {entry.liveModels.length || entry.configuredModelIds.length}{' '}
                              {(entry.liveModels.length || entry.configuredModelIds.length) === 1
                                ? entry.state === 'available'
                                  ? 'model'
                                  : 'configured model'
                                : entry.state === 'available'
                                  ? 'models'
                                  : 'configured models'}
                            </span>
                            {entry.defaultModelId ? (
                              <span className="truncate">Model: {entry.defaultModelId}</span>
                            ) : null}
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="shrink-0 self-start sm:self-auto"
                          onClick={() => beginEditProvider(entry)}
                        >
                          <Pencil className="mr-1.5 size-3.5" />
                          Edit
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 border-t border-dashed border-white/10 py-5 text-left transition-colors hover:border-indigo-300/25"
                    disabled={!availabilityComplete}
                    onClick={beginAddProvider}
                  >
                    <span className="flex size-10 items-center justify-center rounded-xl bg-indigo-400/[0.08] text-indigo-300">
                      <Plus className="size-4" />
                    </span>
                    <span>
                      <span className="block text-sm font-medium text-[var(--color-text)]">
                        Add your first local provider
                      </span>
                      <span className="mt-0.5 block text-[11px] text-[var(--color-text-muted)]">
                        Ollama, LM Studio, Atomic Chat, llama.cpp, or another compatible server.
                      </span>
                    </span>
                  </button>
                )}
              </div>
            </div>
          ) : null}

          {providerView === 'editor' ? (
            <>
              <div className="mt-4">
                <SetupProgress
                  serverComplete={serverConnected}
                  scopeComplete={scopeProgressComplete}
                  modelComplete={Boolean(scopeProgressComplete && selectedModelId)}
                />
              </div>

              <div
                className="mt-1"
                data-testid="runtime-local-provider-setup"
                data-layout="flat-workspace"
                aria-busy={busy || scanLoading || projectPickerLoading}
              >
                <SetupStep
                  number={1}
                  title="Server"
                  description="Connect to the app serving your local models."
                  complete={serverConnected}
                  icon={<Server className="size-4.5" aria-hidden="true" />}
                >
                  <div className="grid gap-3 md:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]">
                    <div className="space-y-1.5">
                      <Label htmlFor="runtime-local-provider-preset">Server app</Label>
                      <Select
                        value={selectedPresetId}
                        disabled={setupLocked}
                        onValueChange={(value) =>
                          selectPreset(value as RuntimeLocalProviderPresetIdDto)
                        }
                      >
                        <SelectTrigger id="runtime-local-provider-preset">
                          <SelectValue>
                            <span className="flex items-center gap-2">
                              <LocalProviderBrandIcon
                                presetId={selectedPreset.id}
                                displayName={selectedPreset.displayName}
                                size="small"
                              />
                              <span>{selectedPreset.displayName}</span>
                            </span>
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {RUNTIME_LOCAL_PROVIDER_PRESETS.map((preset) => (
                            <SelectItem
                              key={preset.id}
                              value={preset.id}
                              textValue={preset.displayName}
                            >
                              <span className="flex items-center gap-2">
                                <LocalProviderBrandIcon
                                  presetId={preset.id}
                                  displayName={preset.displayName}
                                />
                                <span>{preset.displayName}</span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {!savedConfiguration ? (
                        <p className="text-[11px] text-[var(--color-text-muted)]">
                          {selectedPreset.description}
                        </p>
                      ) : null}
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="runtime-local-provider-url">Local server address</Label>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Input
                          id="runtime-local-provider-url"
                          value={baseUrl}
                          disabled={setupLocked}
                          placeholder="http://127.0.0.1:8080/v1"
                          aria-describedby={
                            savedConfiguration ? undefined : 'runtime-local-provider-url-help'
                          }
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          onChange={(event) => {
                            selectionTouchedRef.current = true;
                            setBaseUrl(event.currentTarget.value);
                            resetProbe();
                          }}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          className="shrink-0"
                          disabled={setupLocked || !baseUrl.trim()}
                          onClick={() => void testConnection()}
                        >
                          {phase === 'probing' ? (
                            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                          ) : (
                            <RefreshCcw className="mr-1.5 size-3.5" />
                          )}
                          {serverConnected ? 'Refresh models' : 'Test connection'}
                        </Button>
                      </div>
                      {!savedConfiguration ? (
                        <p
                          id="runtime-local-provider-url-help"
                          className="text-[11px] text-[var(--color-text-muted)]"
                        >
                          Advanced: this is the OpenAI-compatible /v1 address. Localhost or a
                          private local-network address is accepted.
                        </p>
                      ) : null}
                      {privateNetworkUrl && !savedConfiguration ? (
                        <div className="flex items-start gap-2 rounded-md bg-amber-300/[0.05] px-3 py-2.5 text-xs text-amber-100">
                          <Checkbox
                            id="runtime-local-provider-private-network"
                            className="mt-0.5"
                            checked={allowPrivateNetwork}
                            disabled={setupLocked}
                            onCheckedChange={(checked) => {
                              setAllowPrivateNetwork(checked === true);
                              resetProbe();
                            }}
                          />
                          <Label
                            htmlFor="runtime-local-provider-private-network"
                            className="font-normal"
                          >
                            <span className="block">Allow this local network address</span>
                            <span className="mt-0.5 block text-[11px] text-amber-100/70">
                              This server runs on another machine on your network. Traffic is sent
                              over your local network, unencrypted when using HTTP.
                            </span>
                          </Label>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {selectedPresetId === 'custom' ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="runtime-local-provider-id">Provider ID (advanced)</Label>
                      <Input
                        id="runtime-local-provider-id"
                        value={providerId}
                        disabled={setupLocked}
                        placeholder="local"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        onChange={(event) => {
                          selectionTouchedRef.current = true;
                          setProviderId(event.currentTarget.value);
                          resetProbe();
                        }}
                      />
                    </div>
                  ) : null}

                  <div
                    role="status"
                    aria-live="polite"
                    aria-busy={scanLoading || phase === 'probing'}
                    className={`rounded-md px-3 py-2.5 text-xs ${
                      serverConnected
                        ? 'bg-emerald-400/[0.055] text-emerald-200'
                        : 'bg-white/[0.025] text-[var(--color-text-secondary)]'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-medium">
                      {scanLoading ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : probe?.state === 'available' ? (
                        <span className="size-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.45)]" />
                      ) : (
                        <Server className="size-3.5" />
                      )}
                      {scanLoading
                        ? 'Looking for local model servers...'
                        : serverConnected
                          ? `${selectedPreset.displayName} connected`
                          : detectedProbes.length > 0
                            ? `${detectedProbes.map((candidate) => candidate.preset.displayName).join(', ')} ${detectedProbes.length === 1 ? 'is' : 'are'} running. Select one above, or start ${selectedPreset.displayName}.`
                            : 'No local server found automatically. Start one, then click Test connection.'}
                      {serverConnected ? (
                        <>
                          <span className="h-3 w-px bg-emerald-200/20" aria-hidden="true" />
                          <span className="font-normal text-emerald-200/75">
                            {probe?.models.length ?? 0}{' '}
                            {(probe?.models.length ?? 0) === 1 ? 'model' : 'models'} found
                          </span>
                        </>
                      ) : null}
                    </div>
                    {!serverConnected ? (
                      <div className="mt-2 flex items-start gap-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                        <span>{SERVER_START_GUIDANCE[selectedPresetId]}</span>
                      </div>
                    ) : null}
                  </div>

                  {error?.scope === 'server' ? <InlineError message={error.message} /> : null}
                </SetupStep>

                <SetupStep
                  number={2}
                  title="Available for"
                  description="Use this provider everywhere, or save it for one project."
                  complete={scopeProgressComplete}
                  icon={<FolderOpen className="size-4.5" aria-hidden="true" />}
                >
                  <ProviderScopeSelector
                    value={configurationScope}
                    disabled={setupLocked}
                    onChange={changeConfigurationScope}
                  />

                  {configurationScope === 'project' ? (
                    <div className="space-y-1.5 pt-0.5">
                      <Label htmlFor="runtime-local-provider-project">Selected project</Label>
                      <div className="flex flex-col gap-2.5 sm:flex-row">
                        <Combobox
                          id="runtime-local-provider-project"
                          value={projectPath ?? ''}
                          options={projectOptions}
                          placeholder="Choose a project"
                          searchPlaceholder="Search projects..."
                          emptyMessage="No matching projects."
                          className="h-9 min-w-0 flex-1 rounded-lg bg-white/[0.015] px-3.5 shadow-none"
                          disabled={
                            setupLocked || projectPickerLoading || projectOptions.length === 0
                          }
                          onValueChange={(value) => {
                            setError((current) => (current?.scope === 'project' ? null : current));
                            setFolderSelectedProjectPath(null);
                            onProjectPathChange(value);
                          }}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          className="h-9 shrink-0 rounded-lg bg-white/[0.015] px-4"
                          disabled={setupLocked || projectPickerLoading}
                          onClick={() => void chooseProjectFolder()}
                        >
                          {projectPickerLoading ? (
                            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                          ) : (
                            <FolderOpen className="mr-1.5 size-3.5" />
                          )}
                          Choose folder
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {displayedConfigPath ? (
                    <div className="flex items-start gap-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
                      <FolderOpen
                        className="mt-0.5 size-3.5 shrink-0 text-sky-300/80"
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <code className="block break-all text-sky-200">
                          {displayedConfigPathParts?.directory}
                          <span className="whitespace-nowrap">
                            {displayedConfigPathParts?.filename}
                          </span>
                        </code>
                        <p className="mt-1 leading-relaxed text-[var(--color-text-muted)]">
                          {configurationScope === 'global'
                            ? savedConfiguration
                              ? 'Saved globally. Every project can use this provider unless its own config overrides it.'
                              : 'We will update your global OpenCode config. Project configs can still override it.'
                            : savedConfiguration
                              ? 'Saved here. Other projects and global settings were not changed.'
                              : 'We will update or create this project config. Other projects and global settings will not change.'}
                        </p>
                      </div>
                    </div>
                  ) : configurationScope === 'project' ? (
                    <div className="flex items-start gap-2 py-0.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                      Choose a recent project above, or pick any folder. We&apos;ll create its
                      opencode.json without changing other projects.
                    </div>
                  ) : null}

                  {error?.scope === 'project' ? (
                    <InlineError message={error.message} />
                  ) : configurationScope === 'project' && selectedProjectDeleted ? (
                    <InlineError message="This project folder is no longer available. Choose another project or folder." />
                  ) : null}
                </SetupStep>

                <SetupStep
                  number={3}
                  title="Model"
                  description="Pick a model and run one short verification request."
                  complete={Boolean(scopeProgressComplete && selectedModelId)}
                  icon={<Box className="size-4.5" aria-hidden="true" />}
                >
                  {serverHasModels ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="runtime-local-provider-model">Local model</Label>
                      <Select
                        value={selectedModelId}
                        disabled={setupLocked}
                        onValueChange={(modelId) => {
                          setSelectedModelId(modelId);
                          setError((current) => (current?.scope === 'model' ? null : current));
                        }}
                      >
                        <SelectTrigger id="runtime-local-provider-model">
                          <SelectValue placeholder="No models available" />
                        </SelectTrigger>
                        <SelectContent>
                          {(probe?.models ?? []).map((model) => (
                            <SelectItem key={model.id} value={model.id}>
                              {model.displayName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : serverConnected ? (
                    <div className="rounded-r-md border-l-2 border-amber-300/60 bg-amber-300/[0.05] px-3 py-2.5 text-xs text-amber-100">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                        <div className="min-w-0">
                          <div className="font-medium">
                            The server is running, but no models are loaded.
                          </div>
                          <p className="mt-1 text-[11px] leading-relaxed text-amber-100/75">
                            {SERVER_START_GUIDANCE[selectedPresetId]} Then refresh the model list.
                          </p>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="mt-2"
                            disabled={busy}
                            onClick={() => void testConnection()}
                          >
                            <RefreshCcw className="mr-1.5 size-3.5" />
                            Refresh models
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 py-1 text-xs text-[var(--color-text-muted)]">
                      <Info className="size-3.5 shrink-0" aria-hidden="true" />
                      Connect the server to load its models.
                    </div>
                  )}

                  <div className="flex items-start gap-2 text-xs text-[var(--color-text-secondary)]">
                    <Checkbox
                      id="runtime-local-provider-project-default"
                      className="mt-0.5"
                      checked={setAsDefault}
                      disabled={setupLocked || !selectedModelId}
                      onCheckedChange={(checked) => setSetAsDefault(checked === true)}
                    />
                    <Label htmlFor="runtime-local-provider-project-default" className="font-normal">
                      <span className="block text-[var(--color-text)]">
                        {configurationScope === 'global'
                          ? 'Use as global default model'
                          : 'Use as default model for this project'}
                      </span>
                      {!savedConfiguration ? (
                        <span className="mt-0.5 block text-[11px] text-[var(--color-text-muted)]">
                          {setAsDefault
                            ? `This replaces the current ${configurationScope === 'global' ? 'global' : 'project'} default model. All other settings are preserved.`
                            : `This provider will be added without changing the current ${configurationScope === 'global' ? 'global' : 'project'} defaults.`}
                        </span>
                      ) : null}
                    </Label>
                  </div>

                  {setAsDefault ? (
                    <div className="flex items-start gap-2 pl-6 text-xs text-[var(--color-text-secondary)]">
                      <Checkbox
                        id="runtime-local-provider-small-model"
                        className="mt-0.5"
                        checked={setAsSmallModel}
                        disabled={setupLocked || !selectedModelId}
                        onCheckedChange={(checked) => setSetAsSmallModel(checked === true)}
                      />
                      <Label htmlFor="runtime-local-provider-small-model" className="font-normal">
                        <span className="block text-[var(--color-text)]">
                          Also use for lightweight background tasks
                        </span>
                        {!savedConfiguration ? (
                          <span className="mt-0.5 block text-[11px] text-[var(--color-text-muted)]">
                            {setAsSmallModel
                              ? 'OpenCode routes summaries and other small tasks (small_model) to this model too.'
                              : 'The current lightweight-task model (small_model) is kept unchanged.'}
                          </span>
                        ) : null}
                      </Label>
                    </div>
                  ) : null}

                  {error?.scope === 'model' ? <InlineError message={error.message} /> : null}
                </SetupStep>

                {error?.scope === 'setup' ? <InlineError message={error.message} /> : null}
                {savedConfiguration && savedSummary ? (
                  <div
                    role="status"
                    aria-live="polite"
                    aria-busy={phase === 'refreshing' || phase === 'verifying'}
                    className={`rounded-r-md border-l-2 px-3 py-2.5 text-xs ${
                      verificationError
                        ? 'border-amber-300/60 bg-amber-300/[0.05] text-amber-100'
                        : verificationPassed
                          ? 'border-emerald-400/60 bg-emerald-400/[0.055] text-emerald-200'
                          : 'border-sky-400/60 bg-sky-400/[0.05] text-sky-100'
                    }`}
                  >
                    <div className="flex items-start gap-2 font-medium">
                      {phase === 'refreshing' || phase === 'verifying' ? (
                        <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />
                      ) : verificationError ? (
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      ) : (
                        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
                      )}
                      <div>
                        {verificationError
                          ? 'Setup saved, but the model check needs attention.'
                          : verificationPassed
                            ? 'Your local model is ready for Agent Teams.'
                            : savedSummary}
                      </div>
                    </div>
                    {verificationError ? (
                      <>
                        <p className="mt-2 leading-relaxed">{savedSummary}</p>
                        <p className="mt-2 leading-relaxed">{verificationError}</p>
                      </>
                    ) : verificationPassed ? (
                      <>
                        <p className="mt-2 leading-relaxed">{savedSummary}</p>
                        <p className="mt-2">
                          OpenCode ran {selectedModelId}, and the Agent Teams launch preflight
                          passed.
                        </p>
                      </>
                    ) : (
                      <p className="mt-2">
                        {phase === 'verifying'
                          ? `Testing ${selectedModelId} tools and runtime capacity through OpenCode...`
                          : 'Refreshing the provider catalog...'}
                      </p>
                    )}
                    {refreshWarning ? (
                      <p className="mt-2 border-t border-amber-200/15 pt-2 text-amber-200">
                        {refreshWarning}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 flex-col gap-3 border-t border-white/[0.07] bg-gradient-to-r from-indigo-500/[0.025] via-transparent to-sky-500/[0.025] px-6 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-7">
          <div
            role="status"
            aria-live="polite"
            className="min-w-0 text-left text-[11px] leading-relaxed text-[var(--color-text-muted)]"
          >
            {providerView === 'editor' ? (
              <>
                <span className="font-medium text-[var(--color-text-secondary)]">Next: </span>
                {nextAction}
              </>
            ) : (
              <>
                Add as many local providers as you need. Only one model is marked as the{' '}
                {configurationScope === 'global' ? 'global' : 'project'} default.
              </>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            {providerView !== 'editor' ? (
              <Button type="button" variant="outline" onClick={requestClose}>
                Close
              </Button>
            ) : savedConfiguration ? (
              <>
                {phase === 'done' ? (
                  <Button type="button" variant="ghost" onClick={showProviderList}>
                    <ArrowLeft className="mr-1.5 size-3.5" />
                    Back to providers
                  </Button>
                ) : null}
                {phase === 'done' ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="gap-1.5"
                    onClick={beginAddProvider}
                  >
                    <Plus className="size-3.5" />
                    Add another provider
                  </Button>
                ) : null}
                <Button type="button" variant="ghost" onClick={requestClose}>
                  Close
                </Button>
                {phase === 'done' && verificationError ? (
                  <Button
                    type="button"
                    onClick={() =>
                      void verifySavedModel(
                        savedConfiguration,
                        savedConfiguration.scope === 'project'
                          ? (savedProjectPath ?? projectPath)
                          : null
                      )
                    }
                  >
                    <RefreshCcw className="mr-1.5 size-3.5" />
                    Retry verification
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={closeBlocked}
                  onClick={configuredProviders.length > 0 ? showProviderList : requestClose}
                >
                  {configuredProviders.length > 0 ? (
                    <ArrowLeft className="mr-1.5 size-3.5" />
                  ) : null}
                  {configuredProviders.length > 0 ? 'Back to providers' : 'Cancel'}
                </Button>
                <Button
                  type="button"
                  className="border-0 bg-gradient-to-r from-indigo-500 to-sky-500 text-white shadow-[0_8px_24px_rgba(59,130,246,0.18)] hover:from-indigo-400 hover:to-sky-400"
                  disabled={busy || !readyToSave}
                  onClick={() => void configureAndVerify()}
                >
                  {phase === 'configuring' ? (
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  ) : null}
                  {phase === 'configuring' ? 'Saving setup...' : 'Save & verify'}
                </Button>
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
