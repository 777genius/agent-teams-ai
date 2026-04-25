import React from 'react';

import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  RefreshCw,
  Wrench,
  XCircle,
} from 'lucide-react';

import { useTmuxInstallerBanner } from '../hooks/useTmuxInstallerBanner';

const SUMMARY_TITLE = 'tmux is not installed';
const BANNER_MIN_H = 'min-h-[4.25rem]';

const SourceLink = ({
  label,
  url,
  onOpen,
}: {
  label: string;
  url: string;
  onOpen: (url: string) => Promise<void>;
}): React.JSX.Element => (
  <button
    type="button"
    onClick={() => void onOpen(url)}
    className="inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] transition-colors hover:bg-white/5"
    style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
  >
    {label}
    <ExternalLink className="size-3" />
  </button>
);

export function TmuxInstallerBannerView(): React.JSX.Element | null {
  const { viewModel, install, cancel, submitInput, refresh, toggleDetails, openExternal } =
    useTmuxInstallerBanner();
  const [expanded, setExpanded] = React.useState(false);
  const [inputValue, setInputValue] = React.useState('');
  const [manualHintsExpanded, setManualHintsExpanded] = React.useState(false);
  const previousPhaseRef = React.useRef(viewModel.phase);

  React.useEffect(() => {
    if (!viewModel.acceptsInput) {
      setInputValue('');
    }
  }, [viewModel.acceptsInput]);

  React.useEffect(() => {
    if (!viewModel.manualHintsCollapsible) {
      setManualHintsExpanded(false);
    }
  }, [viewModel.manualHintsCollapsible]);

  React.useEffect(() => {
    const previousPhase = previousPhaseRef.current;
    const becameActive =
      previousPhase === 'idle' &&
      viewModel.phase !== 'idle' &&
      viewModel.phase !== 'completed' &&
      viewModel.phase !== 'cancelled';

    if (becameActive) {
      setExpanded(true);
    }

    previousPhaseRef.current = viewModel.phase;
  }, [viewModel.phase]);

  if (!viewModel.visible) {
    return null;
  }

  const manualHintsVisible =
    viewModel.manualHints.length > 0 && (!viewModel.manualHintsCollapsible || manualHintsExpanded);
  const primaryGuideUrl = viewModel.primaryGuideUrl;
  const bannerPaddingClass = expanded ? `py-3 ${BANNER_MIN_H}` : 'py-2.5';

  return (
    <div
      className={`mb-6 rounded-lg border-l-4 px-3 ${bannerPaddingClass}`}
      style={{
        borderLeftColor: viewModel.error ? '#ef4444' : '#f59e0b',
        backgroundColor: 'rgba(245, 158, 11, 0.08)',
        borderColor: 'rgba(245, 158, 11, 0.2)',
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="group flex w-full items-center justify-between gap-3 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-white/[0.03]"
      >
        <span className="flex min-w-0 flex-1 items-start gap-2.5">
          <span className="inline-flex shrink-0 items-center justify-center pt-[3px]">
            {viewModel.error ? (
              <AlertTriangle className="size-3.5 text-red-300" />
            ) : (
              <Wrench className="size-3.5 text-amber-300" />
            )}
          </span>
          <span className="min-w-0">
            <span
              className="block truncate text-xs font-medium leading-5"
              style={{ color: 'var(--color-text)' }}
            >
              {SUMMARY_TITLE}
            </span>
            {!expanded && viewModel.benefitsBody && (
              <span
                className="mt-0.5 block max-w-4xl text-[11px] leading-4"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {viewModel.benefitsBody}
              </span>
            )}
          </span>
        </span>
        <span
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md transition-colors group-hover:bg-white/[0.03]"
          style={{
            color: 'var(--color-text-secondary)',
          }}
        >
          {expanded ? (
            <ChevronUp className="size-3.5 shrink-0" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0" />
          )}
        </span>
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">
          <div className="min-w-0 max-w-4xl">
            {viewModel.title !== SUMMARY_TITLE && (
              <div
                className="text-sm font-medium leading-6"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                {viewModel.title}
              </div>
            )}
            <p
              className="mt-2 text-[15px] leading-7"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              {viewModel.body}
            </p>
            {viewModel.benefitsBody && (
              <div
                className="mt-3 max-w-4xl rounded-md border px-3 py-2 text-[13px] leading-6"
                style={{
                  borderColor: 'rgba(245, 158, 11, 0.18)',
                  backgroundColor: 'rgba(255, 255, 255, 0.03)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                {viewModel.benefitsBody}
              </div>
            )}
            {(viewModel.platformLabel ||
              viewModel.locationLabel ||
              viewModel.runtimeReadyLabel ||
              viewModel.versionLabel ||
              viewModel.phase !== 'idle') && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                {viewModel.platformLabel && (
                  <span
                    className="rounded-full px-2 py-1"
                    style={{
                      color: 'var(--color-text-muted)',
                      backgroundColor: 'rgba(255, 255, 255, 0.04)',
                    }}
                  >
                    Detected OS: {viewModel.platformLabel}
                  </span>
                )}
                {viewModel.locationLabel && (
                  <span
                    className="rounded-full px-2 py-1"
                    style={{
                      color: 'var(--color-text-muted)',
                      backgroundColor: 'rgba(255, 255, 255, 0.04)',
                    }}
                  >
                    Runtime path: {viewModel.locationLabel}
                  </span>
                )}
                {viewModel.runtimeReadyLabel && (
                  <span
                    className="rounded-full px-2 py-1"
                    style={{
                      color: 'var(--color-text-muted)',
                      backgroundColor: 'rgba(255, 255, 255, 0.04)',
                    }}
                  >
                    {viewModel.runtimeReadyLabel}
                  </span>
                )}
                {viewModel.versionLabel && (
                  <span
                    className="rounded-full px-2 py-1"
                    style={{
                      color: 'var(--color-text-muted)',
                      backgroundColor: 'rgba(255, 255, 255, 0.04)',
                    }}
                  >
                    {viewModel.versionLabel}
                  </span>
                )}
                {viewModel.phase !== 'idle' && (
                  <span
                    className="rounded-full px-2 py-1"
                    style={{
                      color: 'var(--color-text-muted)',
                      backgroundColor: 'rgba(255, 255, 255, 0.04)',
                    }}
                  >
                    Phase: {viewModel.phase}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {viewModel.installSupported && (
              <button
                type="button"
                onClick={() => void install()}
                disabled={viewModel.installDisabled}
                className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  viewModel.installButtonPrimary ? 'hover:bg-emerald-500/20' : 'hover:bg-white/5'
                }`}
                style={
                  viewModel.installButtonPrimary
                    ? {
                        borderColor: 'rgba(34, 197, 94, 0.75)',
                        backgroundColor: 'rgba(34, 197, 94, 0.16)',
                        color: '#dcfce7',
                      }
                    : { borderColor: 'var(--color-border)' }
                }
              >
                <Wrench className="size-4" />
                {viewModel.installLabel}
              </button>
            )}
            {viewModel.canCancel && (
              <button
                type="button"
                onClick={() => void cancel()}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-white/5"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <XCircle className="size-4" />
                Cancel
              </button>
            )}
            {primaryGuideUrl && (
              <button
                type="button"
                onClick={() => void openExternal(primaryGuideUrl)}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-white/5"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <ExternalLink className="size-4" />
                Manual guide
              </button>
            )}
            {viewModel.manualHintsCollapsible && (
              <button
                type="button"
                onClick={() => setManualHintsExpanded((current) => !current)}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-white/5"
                style={{ borderColor: 'var(--color-border)' }}
              >
                {manualHintsExpanded ? (
                  <ChevronUp className="size-4" />
                ) : (
                  <ChevronDown className="size-4" />
                )}
                {manualHintsExpanded
                  ? 'Hide setup steps'
                  : `Show setup steps (${viewModel.manualHints.length})`}
              </button>
            )}
            {viewModel.showRefreshButton && (
              <button
                type="button"
                onClick={() => void refresh()}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-white/5"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <RefreshCw className="size-4" />
                Re-check
              </button>
            )}
          </div>

          {viewModel.progressPercent !== null && (
            <div>
              <div className="mb-1 flex items-center justify-between text-[11px]">
                <span style={{ color: 'var(--color-text-muted)' }}>Installer progress</span>
                <span style={{ color: 'var(--color-text-secondary)' }}>
                  {viewModel.progressPercent}%
                </span>
              </div>
              <div
                className="h-2 overflow-hidden rounded-full"
                style={{ backgroundColor: 'rgba(255, 255, 255, 0.08)' }}
              >
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${viewModel.progressPercent}%`,
                    backgroundColor: viewModel.error ? '#ef4444' : '#f59e0b',
                  }}
                />
              </div>
            </div>
          )}

          {viewModel.acceptsInput && (
            <div className="space-y-2">
              <form
                className="flex flex-col gap-2 sm:flex-row sm:items-center"
                onSubmit={(event) => {
                  event.preventDefault();
                  void (async () => {
                    const submitted = await submitInput(inputValue);
                    if (submitted) {
                      setInputValue('');
                    }
                  })();
                }}
              >
                <input
                  type={viewModel.inputSecret ? 'password' : 'text'}
                  value={inputValue}
                  onChange={(event) => setInputValue(event.target.value)}
                  placeholder={viewModel.inputPrompt ?? 'Send input to the installer'}
                  className="min-w-0 flex-1 rounded-md border px-3 py-2 text-sm"
                  style={{
                    borderColor: 'var(--color-border)',
                    backgroundColor: 'rgba(0, 0, 0, 0.12)',
                    color: 'var(--color-text)',
                  }}
                  autoComplete="current-password"
                />
                <button
                  type="submit"
                  className="inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60"
                  style={{ borderColor: 'var(--color-border)' }}
                >
                  Send input
                </button>
              </form>
              {viewModel.inputSecret && (
                <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                  Password input is sent directly to the installer terminal and is not added to the
                  log output.
                </div>
              )}
            </div>
          )}

          {manualHintsVisible && (
            <div className="grid gap-2 lg:grid-cols-2">
              {viewModel.manualHints.map((hint) => (
                <div
                  key={`${hint.title}-${hint.command ?? hint.url ?? hint.description}`}
                  className="rounded-md border px-3 py-2"
                  style={{
                    borderColor: 'rgba(245, 158, 11, 0.18)',
                    backgroundColor: 'rgba(255, 255, 255, 0.02)',
                  }}
                >
                  <div className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>
                    {hint.title}
                  </div>
                  <div className="mt-1 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                    {hint.description}
                  </div>
                  {hint.command && (
                    <code className="mt-2 block rounded bg-black/20 px-2 py-1 font-mono text-[11px]">
                      {hint.command}
                    </code>
                  )}
                  {hint.url && (
                    <div className="mt-2">
                      <SourceLink label={hint.title} url={hint.url} onOpen={openExternal} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {(viewModel.logs.length > 0 || viewModel.error) && (
            <div>
              <button
                type="button"
                onClick={toggleDetails}
                className="text-xs underline-offset-4 hover:underline"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                {viewModel.detailsOpen ? 'Hide details' : 'Show details'}
              </button>
              {viewModel.detailsOpen && (
                <pre
                  className="mt-2 max-h-64 overflow-auto rounded-md border p-3 text-xs"
                  style={{
                    borderColor: 'var(--color-border)',
                    backgroundColor: 'rgba(0, 0, 0, 0.18)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  {[viewModel.error, ...viewModel.logs].filter(Boolean).join('\n')}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
