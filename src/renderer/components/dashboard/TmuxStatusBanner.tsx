import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, isElectronMode } from '@renderer/api';
import { AlertTriangle, ExternalLink, RefreshCw, Wrench } from 'lucide-react';

import type { TmuxPlatform, TmuxStatus } from '@shared/types';

const OFFICIAL_TMUX_INSTALL_URL = 'https://github.com/tmux/tmux/wiki/Installing';
const TMUX_README_URL = 'https://github.com/tmux/tmux/blob/master/README';
const HOMEBREW_TMUX_URL = 'https://formulae.brew.sh/formula/tmux';
const MACPORTS_TMUX_URL = 'https://ports.macports.org/port/tmux/';
const MICROSOFT_WSL_INSTALL_URL = 'https://learn.microsoft.com/en-us/windows/wsl/install';

interface SourceLink {
  label: string;
  url: string;
}

interface PlatformInstallGuideStep {
  kind: 'text' | 'code';
  value: string;
}

interface PlatformInstallGuide {
  platform: Exclude<TmuxPlatform, 'unknown'>;
  title: string;
  steps: PlatformInstallGuideStep[];
  sources: SourceLink[];
}

type BannerState =
  | { loading: true; status: null; error: null }
  | { loading: false; status: TmuxStatus; error: null }
  | { loading: false; status: null; error: string };

const INITIAL_STATE: BannerState = { loading: true, status: null, error: null };

const PLATFORM_INSTALL_GUIDES: readonly PlatformInstallGuide[] = [
  {
    platform: 'darwin',
    title: 'macOS',
    steps: [
      { kind: 'text', value: 'Recommended: Homebrew' },
      { kind: 'code', value: 'brew install tmux' },
      { kind: 'text', value: 'Alternative: MacPorts' },
      { kind: 'code', value: 'sudo port install tmux' },
    ],
    sources: [
      { label: 'tmux guide', url: OFFICIAL_TMUX_INSTALL_URL },
      { label: 'Homebrew', url: HOMEBREW_TMUX_URL },
      { label: 'MacPorts', url: MACPORTS_TMUX_URL },
    ],
  },
  {
    platform: 'linux',
    title: 'Linux',
    steps: [
      { kind: 'text', value: 'Use your distro package manager:' },
      { kind: 'code', value: 'sudo apt install tmux' },
      { kind: 'code', value: 'sudo dnf install tmux' },
      { kind: 'code', value: 'sudo yum install tmux' },
      { kind: 'code', value: 'sudo zypper install tmux' },
      { kind: 'code', value: 'sudo pacman -S tmux' },
    ],
    sources: [{ label: 'tmux guide', url: OFFICIAL_TMUX_INSTALL_URL }],
  },
  {
    platform: 'win32',
    title: 'Windows',
    steps: [
      {
        kind: 'text',
        value: 'The tmux docs do not provide an official native Windows install command.',
      },
      { kind: 'text', value: '1. Install WSL' },
      { kind: 'code', value: 'wsl --install' },
      { kind: 'text', value: '2. Inside Ubuntu or another distro' },
      { kind: 'code', value: 'sudo apt install tmux' },
    ],
    sources: [
      { label: 'tmux README', url: TMUX_README_URL },
      { label: 'tmux guide', url: OFFICIAL_TMUX_INSTALL_URL },
      { label: 'Microsoft WSL', url: MICROSOFT_WSL_INSTALL_URL },
    ],
  },
] as const;

const SourceLinks = ({ links }: { links: SourceLink[] }): React.JSX.Element => {
  return (
    <div className="pt-1">
      <div
        className="text-[10px] uppercase tracking-wide"
        style={{ color: 'var(--color-text-muted)' }}
      >
        Sources
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {links.map((link) => (
          <button
            key={link.url}
            type="button"
            onClick={() => void api.openExternal(link.url)}
            className="inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] transition-colors hover:bg-white/5"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            {link.label}
            <ExternalLink className="size-3" />
          </button>
        ))}
      </div>
    </div>
  );
};

function getPlatformLabel(platform: TmuxPlatform): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  if (platform === 'win32') return 'Windows';
  return 'your OS';
}

const PlatformInstallCard = ({ guide }: { guide: PlatformInstallGuide }): React.JSX.Element => {
  return (
    <div
      className="rounded-md border px-3 py-2"
      style={{
        borderColor: 'rgba(245, 158, 11, 0.18)',
        backgroundColor: 'rgba(255, 255, 255, 0.02)',
      }}
    >
      <div className="mb-1 text-xs font-semibold" style={{ color: 'var(--color-text)' }}>
        {guide.title}
      </div>
      <div className="space-y-1 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
        {guide.steps.map((step) =>
          step.kind === 'code' ? (
            <code
              key={`${guide.platform}-${step.value}`}
              className="block rounded bg-black/20 px-2 py-1 font-mono"
            >
              {step.value}
            </code>
          ) : (
            <div key={`${guide.platform}-${step.value}`}>{step.value}</div>
          )
        )}
        <SourceLinks links={guide.sources} />
      </div>
    </div>
  );
};

const PlatformInstallMatrix = ({ platform }: { platform: TmuxPlatform }): React.JSX.Element => {
  const guides =
    platform === 'unknown'
      ? PLATFORM_INSTALL_GUIDES
      : PLATFORM_INSTALL_GUIDES.filter((guide) => guide.platform === platform);
  const singleGuide = guides.length === 1;

  return (
    <div className="mt-3">
      {singleGuide && (
        <div
          className="mb-2 text-[10px] uppercase tracking-wide"
          style={{ color: 'var(--color-text-muted)' }}
        >
          Detected OS: {getPlatformLabel(platform)}
        </div>
      )}
      <div className={singleGuide ? 'max-w-xl' : 'grid gap-2 lg:grid-cols-3'}>
        {guides.map((guide) => (
          <PlatformInstallCard key={guide.platform} guide={guide} />
        ))}
      </div>
    </div>
  );
};

function getPrimaryDetail(status: TmuxStatus): string {
  if (status.platform === 'darwin') {
    return 'On macOS, the simplest options are Homebrew or MacPorts.';
  }
  if (status.platform === 'linux') {
    return 'On Linux, install tmux with your distro package manager.';
  }
  if (status.platform === 'win32') {
    return 'On Windows, the clearest path is WSL, then installing tmux inside your Linux distro.';
  }
  return 'Install tmux with your operating system package manager.';
}

export const TmuxStatusBanner = (): React.JSX.Element | null => {
  const isElectron = useMemo(() => isElectronMode(), []);
  const [state, setState] = useState<BannerState>(INITIAL_STATE);

  const loadStatus = useCallback(async () => {
    return api.tmux.getStatus();
  }, []);

  const fetchStatus = useCallback(async () => {
    setState(
      (prev) =>
        ({
          loading: true,
          status: prev.status,
          error: null,
        }) as BannerState
    );

    try {
      const status = await loadStatus();
      setState({ loading: false, status, error: null });
    } catch (error) {
      setState({
        loading: false,
        status: null,
        error: error instanceof Error ? error.message : 'Failed to check tmux status',
      });
    }
  }, [loadStatus]);

  useEffect(() => {
    if (!isElectron) {
      return;
    }

    let cancelled = false;

    const loadInitialStatus = async (): Promise<void> => {
      try {
        const status = await loadStatus();
        if (!cancelled) {
          setState({ loading: false, status, error: null });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            loading: false,
            status: null,
            error: error instanceof Error ? error.message : 'Failed to check tmux status',
          });
        }
      }
    };

    void loadInitialStatus();

    return () => {
      cancelled = true;
    };
  }, [isElectron, loadStatus]);

  if (!isElectron) return null;
  if (state.loading && !state.status) return null;

  if (state.error && !state.status) {
    return (
      <div
        className="mb-6 rounded-lg border-l-4 px-4 py-3"
        style={{
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.06)',
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" style={{ color: '#fbbf24' }} />
            <div>
              <div className="text-sm font-medium" style={{ color: '#fbbf24' }}>
                Failed to check tmux availability
              </div>
              <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {state.error}
              </p>
            </div>
          </div>
          <button
            onClick={() => void fetchStatus()}
            className="flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            <RefreshCw className="size-3.5" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!state.status || state.status.available) {
    return null;
  }

  return (
    <div
      className="mb-6 rounded-lg border-l-4 px-4 py-3"
      style={{
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245, 158, 11, 0.06)',
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Wrench className="mt-0.5 size-4 shrink-0" style={{ color: '#fbbf24' }} />
          <div className="min-w-0">
            <div className="text-sm font-medium" style={{ color: '#fbbf24' }}>
              tmux is not installed
            </div>
            <p
              className="mt-1 text-xs leading-relaxed"
              style={{ color: 'var(--color-text-muted)' }}
            >
              Persistent team agents are more reliable on the process/tmux path. Without tmux, the
              app falls back to the heavier in-process path. {getPrimaryDetail(state.status)}
            </p>
            {state.status.error && (
              <p className="mt-1 text-xs" style={{ color: '#fbbf24' }}>
                Last check error: {state.status.error}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => void fetchStatus()}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            <RefreshCw className={`size-3.5 ${state.loading ? 'animate-spin' : ''}`} />
            Re-check
          </button>
          <button
            onClick={() => void api.openExternal(OFFICIAL_TMUX_INSTALL_URL)}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            <ExternalLink className="size-3.5" />
            Official guide
          </button>
        </div>
      </div>

      <PlatformInstallMatrix platform={state.status.platform} />
    </div>
  );
};
