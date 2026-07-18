import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { Checkbox } from '@renderer/components/ui/checkbox';
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
import { CheckCircle2, FolderOpen, Loader2, RefreshCcw, Server } from 'lucide-react';

import { RUNTIME_LOCAL_PROVIDER_PRESETS } from '../core/domain';

import type { RuntimeLocalProviderPresetIdDto, RuntimeLocalProviderProbeDto } from '../contracts';
import type { ProjectPathProject } from '@renderer/components/team/dialogs/projectPathProjects';
import type { JSX, ReactNode } from 'react';

const NO_PROJECT_VALUE = '__local-provider-no-project__';

const getProjectName = (projectPath: string): string =>
  projectPath.split(/[/\\]/).filter(Boolean).pop() ?? projectPath;

const getProjectConfigPath = (projectPath: string): string => {
  const separator = projectPath.includes('\\') && !projectPath.includes('/') ? '\\' : '/';
  return `${projectPath.replace(/[/\\]+$/, '')}${separator}opencode.json`;
};

interface SetupStepProps {
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly complete: boolean;
  readonly children: ReactNode;
}

const SetupStep = ({
  number,
  title,
  description,
  complete,
  children,
}: SetupStepProps): JSX.Element => (
  <section className="rounded-lg border border-white/10 bg-white/[0.015] p-4">
    <div className="flex items-start gap-3">
      <div
        className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
          complete
            ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
            : 'border-white/15 bg-white/[0.03] text-[var(--color-text-secondary)]'
        }`}
        aria-label={complete ? `Step ${number} complete` : `Step ${number}`}
      >
        {complete ? <CheckCircle2 className="size-3.5" /> : number}
      </div>
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-[var(--color-text)]">{title}</h3>
        <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{description}</p>
      </div>
    </div>
    <div className="mt-3 space-y-3 sm:pl-9">{children}</div>
  </section>
);

interface RuntimeLocalProviderSetupDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectPath: string | null;
  readonly projects: readonly ProjectPathProject[];
  readonly onProjectPathChange: (projectPath: string | null) => void;
  readonly onConfigured: () => Promise<void> | void;
}

type SetupPhase = 'idle' | 'probing' | 'configuring' | 'verifying' | 'done';

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
  const [scanProbes, setScanProbes] = useState<readonly RuntimeLocalProviderProbeDto[]>([]);
  const [probe, setProbe] = useState<RuntimeLocalProviderProbeDto | null>(null);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [setAsProjectDefault, setSetAsProjectDefault] = useState(true);
  const [phase, setPhase] = useState<SetupPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [verificationWarning, setVerificationWarning] = useState<string | null>(null);
  const selectionTouchedRef = useRef(false);

  const selectedPreset = useMemo(
    () =>
      RUNTIME_LOCAL_PROVIDER_PRESETS.find((preset) => preset.id === selectedPresetId) ??
      RUNTIME_LOCAL_PROVIDER_PRESETS[0],
    [selectedPresetId]
  );
  const busy = phase === 'probing' || phase === 'configuring' || phase === 'verifying';
  const detectedProbes = scanProbes.filter((candidate) => candidate.state === 'available');
  const projectConfigPath = projectPath ? getProjectConfigPath(projectPath) : null;
  const selectedProjectMissingFromOptions = Boolean(
    projectPath && !projects.some((project) => project.path === projectPath)
  );

  useEffect(() => {
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
    setSetAsProjectDefault(true);
    setProjectPickerLoading(false);
    setPhase('idle');
    setError(null);
    setSuccess(null);
    setVerificationWarning(null);
    setScanLoading(true);
    void api.runtimeProviderManagement
      .scanLocalProviders({ runtimeId: 'opencode' })
      .then((response) => {
        if (cancelled) return;
        if (response.error) {
          setError(response.error.message);
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
        if (!cancelled) {
          setError('Could not scan local model servers. You can still enter an endpoint manually.');
        }
      })
      .finally(() => {
        if (!cancelled) setScanLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const resetProbe = (): void => {
    setProbe(null);
    setSelectedModelId('');
    setError(null);
    setSuccess(null);
    setVerificationWarning(null);
    setPhase('idle');
  };

  const selectPreset = (presetId: RuntimeLocalProviderPresetIdDto): void => {
    selectionTouchedRef.current = true;
    const preset = RUNTIME_LOCAL_PROVIDER_PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    setSelectedPresetId(preset.id);
    setProviderId(preset.providerId);
    setBaseUrl(preset.defaultBaseUrl);
    const scanned = scanProbes.find((candidate) => candidate.preset.id === preset.id) ?? null;
    setProbe(scanned?.state === 'available' ? scanned : null);
    setSelectedModelId(scanned?.models[0]?.id ?? '');
    setError(null);
    setSuccess(null);
    setVerificationWarning(null);
    setPhase('idle');
  };

  const testConnection = async (): Promise<void> => {
    setPhase('probing');
    setError(null);
    setSuccess(null);
    setVerificationWarning(null);
    try {
      const response = await api.runtimeProviderManagement.probeLocalProvider({
        runtimeId: 'opencode',
        presetId: selectedPresetId,
        baseUrl,
        providerId,
      });
      if (response.error) {
        setError(response.error.message);
        setProbe(null);
        return;
      }
      const nextProbe = response.probe ?? null;
      setProbe(nextProbe);
      setSelectedModelId(nextProbe?.models[0]?.id ?? '');
      if (!nextProbe || nextProbe.state !== 'available') {
        setError(nextProbe?.message ?? 'Could not reach the local server.');
      }
    } catch {
      setError('Could not test the local server.');
      setProbe(null);
    } finally {
      setPhase('idle');
    }
  };

  const chooseProjectFolder = async (): Promise<void> => {
    setProjectPickerLoading(true);
    setError(null);
    try {
      const [selectedPath] = await api.config.selectFolders();
      if (selectedPath) {
        onProjectPathChange(selectedPath);
      }
    } catch {
      setError('Could not open the project folder picker.');
    } finally {
      setProjectPickerLoading(false);
    }
  };

  const configureAndVerify = async (): Promise<void> => {
    if (!projectPath) {
      setError('Choose the project that should use this local model.');
      return;
    }
    if (!selectedModelId) {
      setError('Connect the local server and choose a model before saving.');
      return;
    }
    setPhase('configuring');
    setError(null);
    setSuccess(null);
    setVerificationWarning(null);
    try {
      const response = await api.runtimeProviderManagement.configureLocalProvider({
        runtimeId: 'opencode',
        projectPath,
        presetId: selectedPresetId,
        baseUrl,
        providerId,
        defaultModelId: selectedModelId,
        setAsProjectDefault,
      });
      if (response.error || !response.configuration) {
        setError(response.error?.message ?? 'Could not configure the local provider.');
        setPhase('idle');
        return;
      }

      setSuccess(
        `${selectedPreset.displayName} was saved for this project with ${response.configuration.modelIds.length} model${response.configuration.modelIds.length === 1 ? '' : 's'}.`
      );
      try {
        await onConfigured();
      } catch {
        setVerificationWarning(
          'The config was saved, but provider settings could not refresh automatically.'
        );
      }
      setPhase('verifying');
      try {
        const verification = await api.runtimeProviderManagement.testModel({
          runtimeId: 'opencode',
          projectPath,
          providerId: response.configuration.providerId,
          modelId: response.configuration.modelRoute,
        });
        if (verification.error || !verification.result?.ok) {
          setVerificationWarning(
            verification.error?.message ??
              verification.result?.message ??
              'The config was saved, but OpenCode could not verify a model request.'
          );
        }
      } catch {
        setVerificationWarning(
          'The config was saved, but OpenCode could not verify a model request.'
        );
      }
      setPhase('done');
    } catch {
      setError('Could not configure and verify the local provider.');
      setPhase('idle');
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy && !projectPickerLoading) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-h-[min(88vh,780px)] max-w-3xl grid-rows-[minmax(0,1fr)_auto] gap-0 overflow-hidden p-0">
        <div className="min-h-0 overflow-y-auto p-6 pb-4">
          <DialogHeader className="pr-10">
            <DialogTitle>Set up a local model</DialogTitle>
            <DialogDescription>
              Connect Ollama, LM Studio, Atomic Chat, llama.cpp, or another local server. We&apos;ll
              save the setup only for the project you choose.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-4" data-testid="runtime-local-provider-setup">
            <SetupStep
              number={1}
              title="Connect your local server"
              description="Choose the app serving your models, then test its local address."
              complete={probe?.state === 'available'}
            >
              <div className="grid gap-3 sm:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
                <div className="space-y-1.5">
                  <Label htmlFor="runtime-local-provider-preset">Server app</Label>
                  <Select
                    value={selectedPresetId}
                    disabled={busy}
                    onValueChange={(value) =>
                      selectPreset(value as RuntimeLocalProviderPresetIdDto)
                    }
                  >
                    <SelectTrigger id="runtime-local-provider-preset">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RUNTIME_LOCAL_PROVIDER_PRESETS.map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>
                          {preset.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-[var(--color-text-muted)]">
                    {selectedPreset.description}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="runtime-local-provider-url">Local server address</Label>
                  <div className="flex gap-2">
                    <Input
                      id="runtime-local-provider-url"
                      value={baseUrl}
                      disabled={busy}
                      placeholder="http://127.0.0.1:8080/v1"
                      onChange={(event) => {
                        setBaseUrl(event.currentTarget.value);
                        resetProbe();
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0"
                      disabled={busy || !baseUrl.trim()}
                      onClick={() => void testConnection()}
                    >
                      {phase === 'probing' ? (
                        <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                      ) : (
                        <RefreshCcw className="mr-1.5 size-3.5" />
                      )}
                      Test connection
                    </Button>
                  </div>
                  <p className="text-[11px] text-[var(--color-text-muted)]">
                    Advanced: this is the OpenAI-compatible /v1 address. Only localhost is accepted.
                  </p>
                </div>
              </div>

              {selectedPresetId === 'custom' ? (
                <div className="space-y-1.5">
                  <Label htmlFor="runtime-local-provider-id">Provider ID (advanced)</Label>
                  <Input
                    id="runtime-local-provider-id"
                    value={providerId}
                    disabled={busy}
                    placeholder="local"
                    onChange={(event) => {
                      setProviderId(event.currentTarget.value);
                      resetProbe();
                    }}
                  />
                </div>
              ) : null}

              <div className="rounded-md border border-white/10 bg-white/[0.02] p-3 text-xs text-[var(--color-text-secondary)]">
                <div className="flex items-center gap-2 font-medium text-[var(--color-text)]">
                  {scanLoading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : probe?.state === 'available' ? (
                    <CheckCircle2 className="size-3.5 text-emerald-300" />
                  ) : (
                    <Server className="size-3.5" />
                  )}
                  {scanLoading
                    ? 'Looking for local model servers...'
                    : probe?.state === 'available'
                      ? `Connected to ${selectedPreset.displayName}. Found ${probe.models.length} model${probe.models.length === 1 ? '' : 's'}.`
                      : detectedProbes.length > 0
                        ? `Found: ${detectedProbes.map((candidate) => candidate.preset.displayName).join(', ')}`
                        : 'No local server found automatically. Start one, then click Test connection.'}
                </div>
              </div>
            </SetupStep>

            <SetupStep
              number={2}
              title="Choose the project"
              description="This decides where the OpenCode settings file is saved."
              complete={Boolean(projectPath)}
            >
              <div className="space-y-1.5">
                <Label htmlFor="runtime-local-provider-project">
                  Project that will use this model
                </Label>
                <div className="flex gap-2">
                  <Select
                    value={projectPath ?? NO_PROJECT_VALUE}
                    disabled={
                      busy || projectPickerLoading || (projects.length === 0 && !projectPath)
                    }
                    onValueChange={(value) =>
                      onProjectPathChange(value === NO_PROJECT_VALUE ? null : value)
                    }
                  >
                    <SelectTrigger id="runtime-local-provider-project" className="min-w-0 flex-1">
                      <SelectValue placeholder="Choose a project" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_PROJECT_VALUE}>Choose a project</SelectItem>
                      {selectedProjectMissingFromOptions && projectPath ? (
                        <SelectItem value={projectPath}>{getProjectName(projectPath)}</SelectItem>
                      ) : null}
                      {projects.map((project) => (
                        <SelectItem key={project.path} value={project.path}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0"
                    disabled={busy || projectPickerLoading}
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

              {projectConfigPath ? (
                <div className="rounded-md border border-sky-400/20 bg-sky-400/[0.04] p-3 text-xs">
                  <div className="font-medium text-[var(--color-text)]">OpenCode config file</div>
                  <code className="mt-1 block break-all text-sky-200">
                    {projectConfigPath.slice(0, -'opencode.json'.length)}
                    <span className="whitespace-nowrap">opencode.json</span>
                  </code>
                  <p className="mt-2 text-[var(--color-text-secondary)]">
                    We&apos;ll create or update this file. Other projects and global settings
                    won&apos;t change. No manual editing is needed.
                  </p>
                </div>
              ) : (
                <div className="rounded-md border border-white/10 bg-white/[0.02] p-3 text-xs text-[var(--color-text-secondary)]">
                  Choose a recent project above, or pick any folder. We&apos;ll create its
                  opencode.json without changing other projects.
                </div>
              )}
            </SetupStep>

            <SetupStep
              number={3}
              title="Choose a model"
              description="We will run one short request to confirm the model works through OpenCode."
              complete={probe?.state === 'available' && Boolean(selectedModelId)}
            >
              {probe?.state === 'available' ? (
                <div className="space-y-1.5">
                  <Label htmlFor="runtime-local-provider-model">Local model</Label>
                  <Select
                    value={selectedModelId}
                    disabled={busy || probe.models.length === 0}
                    onValueChange={setSelectedModelId}
                  >
                    <SelectTrigger id="runtime-local-provider-model">
                      <SelectValue placeholder="No models available" />
                    </SelectTrigger>
                    <SelectContent>
                      {probe.models.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="rounded-md border border-white/10 bg-white/[0.02] p-3 text-xs text-[var(--color-text-secondary)]">
                  Complete step 1 to load models from your local server.
                </div>
              )}

              <div className="flex items-start gap-2 text-xs text-[var(--color-text-secondary)]">
                <Checkbox
                  id="runtime-local-provider-project-default"
                  className="mt-0.5"
                  checked={setAsProjectDefault}
                  disabled={busy || !selectedModelId}
                  onCheckedChange={(checked) => setSetAsProjectDefault(checked === true)}
                />
                <Label htmlFor="runtime-local-provider-project-default" className="font-normal">
                  <span className="block text-[var(--color-text)]">
                    Use this as the default model for this project
                  </span>
                  <span className="mt-0.5 block text-[11px] text-[var(--color-text-muted)]">
                    OpenCode will use it for regular and lightweight tasks. Existing unrelated
                    settings are preserved.
                  </span>
                </Label>
              </div>
            </SetupStep>

            {error ? (
              <div
                role="alert"
                className="rounded-md border border-red-400/25 bg-red-400/[0.06] p-3 text-xs text-red-200"
              >
                {error}
              </div>
            ) : null}
            {success ? (
              <div className="rounded-md border border-emerald-400/25 bg-emerald-400/[0.06] p-3 text-xs text-emerald-200">
                <div className="flex items-center gap-2 font-medium">
                  <CheckCircle2 className="size-3.5" />
                  {success}
                </div>
                {verificationWarning ? (
                  <div className="mt-2 text-amber-200">
                    Saved, but model verification needs attention: {verificationWarning}
                  </div>
                ) : phase === 'done' ? (
                  <div className="mt-2">OpenCode successfully ran {selectedModelId}.</div>
                ) : (
                  <div className="mt-2 flex items-center gap-2">
                    <Loader2 className="size-3.5 animate-spin" />
                    {phase === 'verifying'
                      ? `Testing ${selectedModelId} through OpenCode...`
                      : 'Setup saved. Refreshing the provider catalog...'}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-white/10 bg-[var(--color-surface)] px-6 py-4">
          <Button
            type="button"
            variant="ghost"
            disabled={busy || projectPickerLoading}
            onClick={() => onOpenChange(false)}
          >
            {phase === 'done' ? 'Close' : 'Cancel'}
          </Button>
          {phase !== 'done' ? (
            <Button
              type="button"
              disabled={busy || !projectPath || !selectedModelId || probe?.state !== 'available'}
              onClick={() => void configureAndVerify()}
            >
              {phase === 'configuring' || phase === 'verifying' ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : null}
              {phase === 'configuring'
                ? 'Saving setup...'
                : phase === 'verifying'
                  ? 'Verifying...'
                  : 'Save setup and verify'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
