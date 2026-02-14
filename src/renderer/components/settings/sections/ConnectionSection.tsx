/**
 * ConnectionSection - Settings section for SSH connection management.
 *
 * Provides UI for:
 * - Toggling between local and SSH modes
 * - Configuring SSH connection (host, port, username, auth)
 * - SSH config host alias combobox with auto-fill
 * - Testing and connecting to remote hosts
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { useStore } from '@renderer/store';
import { getFullResetState } from '@renderer/store/utils/stateResetHelpers';
import { FolderOpen, Laptop, Loader2, Monitor, RotateCcw, Server, Wifi, WifiOff } from 'lucide-react';

import { SettingRow } from '../components/SettingRow';
import { SettingsSectionHeader } from '../components/SettingsSectionHeader';
import { SettingsSelect } from '../components/SettingsSelect';

import type {
  ClaudeRootInfo,
  SshAuthMethod,
  SshConfigHostEntry,
  SshConnectionConfig,
  SshConnectionProfile,
  WslClaudeRootCandidate,
} from '@shared/types';

const authMethodOptions: readonly { value: SshAuthMethod; label: string }[] = [
  { value: 'auto', label: 'Auto (from SSH Config)' },
  { value: 'agent', label: 'SSH Agent' },
  { value: 'privateKey', label: 'Private Key' },
  { value: 'password', label: 'Password' },
];

export const ConnectionSection = (): React.JSX.Element => {
  const connectionMode = useStore((s) => s.connectionMode);
  const connectionState = useStore((s) => s.connectionState);
  const connectedHost = useStore((s) => s.connectedHost);
  const connectionError = useStore((s) => s.connectionError);
  const connectSsh = useStore((s) => s.connectSsh);
  const disconnectSsh = useStore((s) => s.disconnectSsh);
  const testConnection = useStore((s) => s.testConnection);
  const sshConfigHosts = useStore((s) => s.sshConfigHosts);
  const fetchSshConfigHosts = useStore((s) => s.fetchSshConfigHosts);
  const lastSshConfig = useStore((s) => s.lastSshConfig);
  const loadLastConnection = useStore((s) => s.loadLastConnection);
  const fetchProjects = useStore((s) => s.fetchProjects);
  const fetchRepositoryGroups = useStore((s) => s.fetchRepositoryGroups);

  // Form state
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [authMethod, setAuthMethod] = useState<SshAuthMethod>('auto');
  const [password, setPassword] = useState('');
  const [privateKeyPath, setPrivateKeyPath] = useState('~/.ssh/id_rsa');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  // Combobox state
  const [showDropdown, setShowDropdown] = useState(false);
  const hostInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Saved profiles
  const [savedProfiles, setSavedProfiles] = useState<SshConnectionProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [claudeRootInfo, setClaudeRootInfo] = useState<ClaudeRootInfo | null>(null);
  const [updatingClaudeRoot, setUpdatingClaudeRoot] = useState(false);
  const [claudeRootError, setClaudeRootError] = useState<string | null>(null);
  const [findingWslRoots, setFindingWslRoots] = useState(false);
  const [wslCandidates, setWslCandidates] = useState<WslClaudeRootCandidate[]>([]);
  const [showWslModal, setShowWslModal] = useState(false);

  const loadProfiles = useCallback(async () => {
    try {
      const config = await api.config.get();
      const loaded = config.ssh;
      setSavedProfiles(loaded?.profiles ?? []);
    } catch {
      // ignore
    }
  }, []);

  const loadClaudeRootInfo = useCallback(async () => {
    try {
      const info = await api.config.getClaudeRootInfo();
      setClaudeRootInfo(info);
    } catch (error) {
      setClaudeRootError(
        error instanceof Error ? error.message : 'Failed to load local Claude root settings'
      );
    }
  }, []);

  // Fetch SSH config hosts, saved profiles, and load last connection on mount
  useEffect(() => {
    void fetchSshConfigHosts();
    void loadLastConnection();
    void loadProfiles();
    void loadClaudeRootInfo();
  }, [fetchSshConfigHosts, loadLastConnection, loadProfiles, loadClaudeRootInfo]);

  // Pre-fill form from saved connection config when it arrives (one-time on mount).
  // setState in effect is intentional: lastSshConfig loads async from IPC, so we can't
  // use it as useState initializers.
  const prefilled = useRef(false);
  useEffect(() => {
    if (lastSshConfig && connectionState !== 'connected' && !prefilled.current) {
      prefilled.current = true;
      setHost(lastSshConfig.host);
      setPort(String(lastSshConfig.port));
      setUsername(lastSshConfig.username);
      setAuthMethod(lastSshConfig.authMethod);
      if (lastSshConfig.privateKeyPath) {
        setPrivateKeyPath(lastSshConfig.privateKeyPath);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time prefill when async data arrives
  }, [lastSshConfig]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        hostInputRef.current &&
        !hostInputRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Filter config hosts based on input
  const filteredHosts = useMemo(() => {
    if (!host.trim()) return sshConfigHosts;
    const lower = host.toLowerCase();
    return sshConfigHosts.filter(
      (entry) =>
        entry.alias.toLowerCase().includes(lower) || entry.hostName?.toLowerCase().includes(lower)
    );
  }, [host, sshConfigHosts]);

  const clearProfileSelection = (): void => setSelectedProfileId(null);

  const handleSelectConfigHost = (entry: SshConfigHostEntry): void => {
    setHost(entry.alias);
    if (entry.port) setPort(String(entry.port));
    if (entry.user) setUsername(entry.user);
    setAuthMethod('auto');
    setShowDropdown(false);
    setTestResult(null);
    clearProfileSelection();
  };

  const handleSelectProfile = (profile: SshConnectionProfile): void => {
    setHost(profile.host);
    setPort(String(profile.port));
    setUsername(profile.username);
    setAuthMethod(profile.authMethod);
    if (profile.privateKeyPath) setPrivateKeyPath(profile.privateKeyPath);
    setPassword('');
    setTestResult(null);
    setSelectedProfileId(profile.id);
  };

  const buildConfig = (): SshConnectionConfig => ({
    host,
    port: parseInt(port, 10) || 22,
    username,
    authMethod,
    password: authMethod === 'password' ? password : undefined,
    privateKeyPath: authMethod === 'privateKey' ? privateKeyPath : undefined,
  });

  const handleTest = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    const result = await testConnection(buildConfig());
    setTestResult(result);
    setTesting(false);
  };

  const handleConnect = async (): Promise<void> => {
    await connectSsh(buildConfig());
  };

  const handleDisconnect = async (): Promise<void> => {
    await disconnectSsh();
  };

  const resetWorkspaceForRootChange = useCallback((): void => {
    useStore.setState({
      projects: [],
      repositoryGroups: [],
      openTabs: [],
      activeTabId: null,
      selectedTabIds: [],
      paneLayout: {
        panes: [
          {
            id: 'pane-default',
            tabs: [],
            activeTabId: null,
            selectedTabIds: [],
            widthFraction: 1,
          },
        ],
        focusedPaneId: 'pane-default',
      },
      ...getFullResetState(),
    });
  }, []);

  const applyClaudeRootPath = useCallback(
    async (claudeRootPath: string | null): Promise<void> => {
      try {
        setUpdatingClaudeRoot(true);
        setClaudeRootError(null);

        await api.config.update('general', { claudeRootPath });
        await loadClaudeRootInfo();

        if (connectionMode === 'local') {
          resetWorkspaceForRootChange();
          await Promise.all([fetchProjects(), fetchRepositoryGroups()]);
        }
      } catch (error) {
        setClaudeRootError(error instanceof Error ? error.message : 'Failed to update Claude root');
      } finally {
        setUpdatingClaudeRoot(false);
      }
    },
    [
      connectionMode,
      fetchProjects,
      fetchRepositoryGroups,
      loadClaudeRootInfo,
      resetWorkspaceForRootChange,
    ]
  );

  const handleSelectClaudeRootFolder = useCallback(async (): Promise<void> => {
    setClaudeRootError(null);

    const selection = await api.config.selectClaudeRootFolder();
    if (!selection) {
      return;
    }

    if (!selection.isClaudeDirName) {
      const proceed = await confirm({
        title: 'Selected folder is not .claude',
        message: `This folder is named "${selection.path.split(/[\\/]/).pop() ?? selection.path}", not ".claude". Continue anyway?`,
        confirmLabel: 'Use Folder',
      });
      if (!proceed) {
        return;
      }
    }

    if (!selection.hasProjectsDir) {
      const proceed = await confirm({
        title: 'No projects directory found',
        message: 'This folder does not contain a "projects" directory. Continue anyway?',
        confirmLabel: 'Use Folder',
      });
      if (!proceed) {
        return;
      }
    }

    await applyClaudeRootPath(selection.path);
  }, [applyClaudeRootPath]);

  const handleResetClaudeRoot = useCallback(async (): Promise<void> => {
    await applyClaudeRootPath(null);
  }, [applyClaudeRootPath]);

  const applyWslCandidate = useCallback(
    async (candidate: WslClaudeRootCandidate): Promise<void> => {
      if (!candidate.hasProjectsDir) {
        const proceed = await confirm({
          title: 'WSL path missing projects directory',
          message: `"${candidate.path}" does not contain a "projects" directory. Continue anyway?`,
          confirmLabel: 'Use Path',
        });
        if (!proceed) {
          return;
        }
      }

      await applyClaudeRootPath(candidate.path);
      setShowWslModal(false);
    },
    [applyClaudeRootPath]
  );

  const handleUseWslForClaude = useCallback(async (): Promise<void> => {
    try {
      setFindingWslRoots(true);
      setClaudeRootError(null);
      const candidates = await api.config.findWslClaudeRoots();
      setWslCandidates(candidates);

      if (candidates.length === 0) {
        const pickManually = await confirm({
          title: 'No WSL Claude paths found',
          message: 'Could not find WSL distros with Claude data automatically. Select folder manually?',
          confirmLabel: 'Select Folder',
        });
        if (pickManually) {
          await handleSelectClaudeRootFolder();
        }
        return;
      }

      const candidatesWithProjects = candidates.filter((candidate) => candidate.hasProjectsDir);
      if (candidatesWithProjects.length === 1) {
        await applyWslCandidate(candidatesWithProjects[0]);
        return;
      }

      setShowWslModal(true);
    } catch (error) {
      setClaudeRootError(
        error instanceof Error ? error.message : 'Failed to detect WSL Claude root paths'
      );
    } finally {
      setFindingWslRoots(false);
    }
  }, [applyWslCandidate, handleSelectClaudeRootFolder]);

  const isConnecting = connectionState === 'connecting';
  const isConnected = connectionState === 'connected';
  const isCustomClaudeRoot = Boolean(claudeRootInfo?.customPath);
  const resolvedClaudeRootPath = claudeRootInfo?.resolvedPath ?? '~/.claude';
  const defaultClaudeRootPath = claudeRootInfo?.defaultPath ?? '~/.claude';
  const isWindowsStyleDefaultPath =
    /^[a-zA-Z]:\\/.test(defaultClaudeRootPath) || defaultClaudeRootPath.startsWith('\\\\');

  const inputClass = 'w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-1';
  const inputStyle = {
    backgroundColor: 'var(--color-surface-raised)',
    borderColor: 'var(--color-border)',
    color: 'var(--color-text)',
  };

  return (
    <div className="space-y-6">
      <SettingsSectionHeader title="Local Claude Root" />
      <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
        Choose which local folder is treated as your Claude data root
      </p>

      <SettingRow
        label="Current Local Root"
        description={isCustomClaudeRoot ? 'Using custom path' : 'Using auto-detected path'}
      >
        <div className="max-w-96 text-right">
          <div className="truncate font-mono text-xs" style={{ color: 'var(--color-text)' }}>
            {resolvedClaudeRootPath}
          </div>
          <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            Auto-detected: {defaultClaudeRootPath}
          </div>
        </div>
      </SettingRow>

      <div className="flex items-center gap-3">
        <button
          onClick={() => void handleSelectClaudeRootFolder()}
          disabled={updatingClaudeRoot}
          className="rounded-md px-4 py-1.5 text-sm transition-colors disabled:opacity-50"
          style={{
            backgroundColor: 'var(--color-surface-raised)',
            color: 'var(--color-text)',
          }}
        >
          <span className="flex items-center gap-2">
            {updatingClaudeRoot ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <FolderOpen className="size-3" />
            )}
            Select Folder
          </span>
        </button>

        <button
          onClick={() => void handleResetClaudeRoot()}
          disabled={updatingClaudeRoot || !isCustomClaudeRoot}
          className="rounded-md px-4 py-1.5 text-sm transition-colors disabled:opacity-50"
          style={{
            backgroundColor: 'var(--color-surface-raised)',
            color: 'var(--color-text-secondary)',
          }}
        >
          <span className="flex items-center gap-2">
            <RotateCcw className="size-3" />
            Use Auto-Detect
          </span>
        </button>

        {isWindowsStyleDefaultPath && (
          <button
            onClick={() => void handleUseWslForClaude()}
            disabled={updatingClaudeRoot || findingWslRoots}
            className="rounded-md px-4 py-1.5 text-sm transition-colors disabled:opacity-50"
            style={{
              backgroundColor: 'var(--color-surface-raised)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <span className="flex items-center gap-2">
              {findingWslRoots ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Laptop className="size-3" />
              )}
              Using Linux/WSL?
            </span>
          </button>
        )}
      </div>

      {claudeRootError && (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 px-4 py-3">
          <p className="text-sm text-red-400">{claudeRootError}</p>
        </div>
      )}

      {showWslModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <button
            className="absolute inset-0 cursor-default"
            style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
            onClick={() => setShowWslModal(false)}
            aria-label="Close WSL path modal"
            tabIndex={-1}
          />
          <div
            className="relative mx-4 w-full max-w-2xl rounded-lg border p-5 shadow-xl"
            style={{
              backgroundColor: 'var(--color-surface-overlay)',
              borderColor: 'var(--color-border-emphasis)',
            }}
          >
            <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
              Select WSL Claude Root
            </h3>
            <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Detected WSL distributions and Claude root candidates
            </p>

            <div className="mt-4 space-y-2">
              {wslCandidates.map((candidate) => (
                <div
                  key={`${candidate.distro}:${candidate.path}`}
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                  style={{ borderColor: 'var(--color-border)' }}
                >
                  <div className="min-w-0">
                    <p className="text-xs font-medium" style={{ color: 'var(--color-text)' }}>
                      {candidate.distro}
                    </p>
                    <p
                      className="truncate font-mono text-[11px]"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      {candidate.path}
                    </p>
                    {!candidate.hasProjectsDir && (
                      <p className="text-[11px] text-amber-400">No projects directory detected</p>
                    )}
                  </div>
                  <button
                    onClick={() => void applyWslCandidate(candidate)}
                    className="rounded-md px-3 py-1.5 text-xs transition-colors"
                    style={{
                      backgroundColor: 'var(--color-surface-raised)',
                      color: 'var(--color-text)',
                    }}
                  >
                    Use This Path
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => setShowWslModal(false)}
                className="rounded-md border px-3 py-1.5 text-xs transition-colors hover:bg-white/5"
                style={{
                  borderColor: 'var(--color-border)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowWslModal(false);
                  void handleSelectClaudeRootFolder();
                }}
                className="rounded-md px-3 py-1.5 text-xs transition-colors"
                style={{
                  backgroundColor: 'var(--color-surface-raised)',
                  color: 'var(--color-text)',
                }}
              >
                Select Folder Manually
              </button>
            </div>
          </div>
        </div>
      )}

      <SettingsSectionHeader title="Remote Connection" />
      <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
        Connect to a remote machine to view Claude Code sessions running there
      </p>

      {/* Connection Status */}
      {isConnected && (
        <div
          className="flex items-center gap-3 rounded-md border px-4 py-3"
          style={{
            borderColor: 'rgba(34, 197, 94, 0.3)',
            backgroundColor: 'rgba(34, 197, 94, 0.05)',
          }}
        >
          <Wifi className="size-4 text-green-400" />
          <div className="flex-1">
            <p className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
              Connected to {connectedHost}
            </p>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Viewing remote sessions via SSH
            </p>
          </div>
          <button
            onClick={() => void handleDisconnect()}
            className="rounded-md px-3 py-1.5 text-sm transition-colors"
            style={{
              backgroundColor: 'var(--color-surface-raised)',
              color: 'var(--color-text-secondary)',
            }}
          >
            Disconnect
          </button>
        </div>
      )}

      {connectionError && (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 px-4 py-3">
          <p className="text-sm text-red-400">{connectionError}</p>
        </div>
      )}

      {/* Mode indicator */}
      {!isConnected && (
        <SettingRow label="Current Mode" description="Data source for session files">
          <div
            className="flex items-center gap-2 text-sm"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <Monitor className="size-4" />
            <span>Local ({resolvedClaudeRootPath})</span>
          </div>
        </SettingRow>
      )}

      {/* Saved Profiles */}
      {!isConnected && savedProfiles.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium" style={{ color: 'var(--color-text-secondary)' }}>
            Saved Profiles
          </h3>
          <div className="flex flex-wrap gap-2">
            {savedProfiles.map((profile) => {
              const isSelected = selectedProfileId === profile.id;
              return (
                <button
                  key={profile.id}
                  type="button"
                  onClick={() => handleSelectProfile(profile)}
                  className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors ${isSelected ? '' : 'hover:bg-surface-raised'}`}
                  style={{
                    borderColor: isSelected ? 'rgba(99, 102, 241, 0.4)' : 'var(--color-border)',
                    backgroundColor: isSelected ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
                    color: isSelected ? 'var(--color-text)' : 'var(--color-text-secondary)',
                  }}
                >
                  <Server
                    className="size-3.5"
                    style={{
                      color: isSelected ? 'rgb(129, 140, 248)' : 'var(--color-text-muted)',
                    }}
                  />
                  <span>{profile.name}</span>
                  <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {profile.username}@{profile.host}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* SSH Connection Form */}
      {!isConnected && (
        <div className="space-y-4">
          <h3 className="text-sm font-medium" style={{ color: 'var(--color-text-secondary)' }}>
            SSH Connection
          </h3>

          <div className="grid grid-cols-2 gap-3">
            {/* Host input with combobox */}
            <div className="relative">
              <label
                htmlFor="ssh-host"
                className="mb-1 block text-xs"
                style={{ color: 'var(--color-text-muted)' }}
              >
                Host
              </label>
              <input
                id="ssh-host"
                ref={hostInputRef}
                type="text"
                value={host}
                onChange={(e) => {
                  setHost(e.target.value);
                  setShowDropdown(true);
                  setTestResult(null);
                  clearProfileSelection();
                }}
                onFocus={() => setShowDropdown(true)}
                placeholder="hostname or ssh config alias"
                className={inputClass}
                style={inputStyle}
              />
              {showDropdown && filteredHosts.length > 0 && (
                <div
                  ref={dropdownRef}
                  className="absolute z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-md border shadow-lg"
                  style={{
                    backgroundColor: 'var(--color-surface-overlay)',
                    borderColor: 'var(--color-border-emphasis)',
                  }}
                >
                  {filteredHosts.map((entry) => (
                    <button
                      key={entry.alias}
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-raised"
                      style={{
                        color: 'var(--color-text)',
                      }}
                      onClick={() => handleSelectConfigHost(entry)}
                    >
                      <span className="font-medium">{entry.alias}</span>
                      {entry.hostName && (
                        <span style={{ color: 'var(--color-text-muted)' }}>{entry.hostName}</span>
                      )}
                      {entry.user && (
                        <span
                          className="ml-auto text-xs"
                          style={{ color: 'var(--color-text-muted)' }}
                        >
                          {entry.user}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <label
                htmlFor="ssh-port"
                className="mb-1 block text-xs"
                style={{ color: 'var(--color-text-muted)' }}
              >
                Port
              </label>
              <input
                id="ssh-port"
                type="text"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="22"
                className={inputClass}
                style={inputStyle}
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="ssh-username"
              className="mb-1 block text-xs"
              style={{ color: 'var(--color-text-muted)' }}
            >
              Username
            </label>
            <input
              id="ssh-username"
              type="text"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                clearProfileSelection();
              }}
              placeholder="user"
              className={inputClass}
              style={inputStyle}
            />
          </div>

          <div>
            {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- SettingsSelect is a custom dropdown without a native control */}
            <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Authentication
            </label>
            <SettingsSelect
              value={authMethod}
              options={authMethodOptions}
              onChange={setAuthMethod}
              fullWidth
            />
          </div>

          {authMethod === 'privateKey' && (
            <div>
              <label
                htmlFor="ssh-private-key-path"
                className="mb-1 block text-xs"
                style={{ color: 'var(--color-text-muted)' }}
              >
                Private Key Path
              </label>
              <input
                id="ssh-private-key-path"
                type="text"
                value={privateKeyPath}
                onChange={(e) => setPrivateKeyPath(e.target.value)}
                placeholder="~/.ssh/id_rsa"
                className={inputClass}
                style={inputStyle}
              />
            </div>
          )}

          {authMethod === 'password' && (
            <div>
              <label
                htmlFor="ssh-password"
                className="mb-1 block text-xs"
                style={{ color: 'var(--color-text-muted)' }}
              >
                Password
              </label>
              <input
                id="ssh-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
                style={inputStyle}
              />
            </div>
          )}

          {/* Test result */}
          {testResult && (
            <div
              className={`rounded-md border px-3 py-2 text-sm ${
                testResult.success
                  ? 'border-green-500/20 bg-green-500/10 text-green-400'
                  : 'border-red-500/20 bg-red-500/10 text-red-400'
              }`}
            >
              {testResult.success
                ? 'Connection successful'
                : `Connection failed: ${testResult.error ?? 'Unknown error'}`}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => void handleTest()}
              disabled={!host || testing || isConnecting}
              className="rounded-md px-4 py-1.5 text-sm transition-colors disabled:opacity-50"
              style={{
                backgroundColor: 'var(--color-surface-raised)',
                color: 'var(--color-text-secondary)',
              }}
            >
              {testing ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  Testing...
                </span>
              ) : (
                'Test Connection'
              )}
            </button>

            <button
              onClick={() => void handleConnect()}
              disabled={!host || isConnecting}
              className="rounded-md px-4 py-1.5 text-sm transition-colors disabled:opacity-50"
              style={{
                backgroundColor: 'var(--color-surface-raised)',
                color: 'var(--color-text)',
              }}
            >
              {isConnecting ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  Connecting...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <WifiOff className="size-3" />
                  Connect
                </span>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
