export type DownloadOs = 'macos' | 'windows' | 'linux';
export type DownloadArch = 'arm64' | 'x64' | 'universal';

export const downloadAssets = [
  {
    id: 'macos',
    os: 'macos',
    arch: 'universal',
    label: 'macOS',
    archLabel: 'Apple Silicon / Intel',
    fileName: 'Agent.Teams.AI-arm64.dmg',
  },
  {
    id: 'windows',
    os: 'windows',
    arch: 'universal',
    label: 'Windows',
    archLabel: '64-bit / ARM64',
    fileName: 'Agent.Teams.AI.Setup.exe',
  },
  {
    id: 'linux-appimage',
    os: 'linux',
    arch: 'x64',
    label: 'Linux',
    archLabel: '64-bit',
    fileName: 'Agent.Teams.AI.AppImage',
  },
] as const;
