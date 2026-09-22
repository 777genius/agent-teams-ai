import path from 'node:path';

import type { RuntimeProviderCliCompanionDefinition } from '../types';

const CURSOR_INSTALL_URL = 'https://cursor.com/install';
const CURSOR_WINDOWS_INSTALL_URL = 'https://cursor.com/install?win32=true';
const CURSOR_INSTALL_GUIDE_URL = 'https://cursor.com/docs/cli/installation';
const MINIMUM_INSTALL_FREE_BYTES = 1024 * 1024 * 1024;

function validateCursorInstallerScript(script: string, platform: NodeJS.Platform): void {
  const markers =
    platform === 'win32'
      ? [
          'https://downloads.cursor.com/',
          'Initialize-CursorAgent',
          'Invoke-WebRequest',
          'cursor-agent',
        ]
      : [
          '#!/usr/bin/env bash',
          'Cursor Agent Installer',
          'https://downloads.cursor.com/',
          'cursor-agent',
        ];
  if (!markers.every((marker) => script.includes(marker))) {
    throw new Error(
      'Cursor changed its installer format; automatic installation was stopped safely'
    );
  }
}

export const CURSOR_AGENT_COMPANION_DEFINITION: RuntimeProviderCliCompanionDefinition = {
  companionId: 'cursor-agent',
  displayName: 'Cursor Agent',
  verification: {
    providerId: 'cursor-acp',
    modelId: 'cursor-acp/auto',
  },
  supportsPlatform: (platform, arch) =>
    ['darwin', 'linux', 'win32'].includes(platform) && ['x64', 'arm64'].includes(arch),
  installer: {
    url: (platform) => (platform === 'win32' ? CURSOR_WINDOWS_INSTALL_URL : CURSOR_INSTALL_URL),
    allowedFinalHosts: ['cursor.com'],
    scriptFileName: (platform) => (platform === 'win32' ? 'install.ps1' : 'install.sh'),
    command: (platform, scriptPath) =>
      platform === 'win32'
        ? {
            command: 'powershell.exe',
            args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
          }
        : { command: '/bin/bash', args: [scriptPath] },
    validateScript: validateCursorInstallerScript,
    manualCommand: (platform) =>
      platform === 'win32'
        ? "irm 'https://cursor.com/install?win32=true' | iex"
        : 'curl https://cursor.com/install -fsS | bash',
    manualUrl: CURSOR_INSTALL_GUIDE_URL,
    minimumFreeBytes: MINIMUM_INSTALL_FREE_BYTES,
    monitorDownload: false,
    packageDescription: 'official Cursor Agent package',
    parseProgress: (text) => {
      const normalized = text.toLowerCase();
      if (
        normalized.includes('downloading cursor agent package') ||
        normalized.includes('download-installpackage')
      ) {
        return { percent: 42, detail: 'Downloading the official Cursor Agent package...' };
      }
      if (
        normalized.includes('package downloaded and extracted') ||
        normalized.includes('expand-archive')
      ) {
        return { percent: 62, detail: 'Extracting the Cursor Agent package...' };
      }
      if (
        normalized.includes('installation complete') ||
        normalized.includes('happy coding') ||
        normalized.includes('package installed successfully')
      ) {
        return { percent: 76, detail: 'Cursor Agent package installed.' };
      }
      return null;
    },
  },
  binary: {
    executableNames: (platform) =>
      platform === 'win32'
        ? [
            'agent.exe',
            'cursor-agent.exe',
            'agent.cmd',
            'cursor-agent.cmd',
            'agent',
            'cursor-agent',
          ]
        : ['agent', 'cursor-agent'],
    extraCandidates: (platform, homeDir) => {
      if (platform === 'win32') {
        const root = path.join(process.env.LOCALAPPDATA ?? '', 'cursor-agent');
        return [
          path.join(root, 'agent.exe'),
          path.join(root, 'cursor-agent.exe'),
          path.join(root, 'agent.cmd'),
          path.join(root, 'cursor-agent.cmd'),
        ];
      }
      return [
        path.join(homeDir, '.local', 'bin', 'agent'),
        path.join(homeDir, '.local', 'bin', 'cursor-agent'),
        '/usr/local/bin/agent',
        '/usr/local/bin/cursor-agent',
        '/opt/homebrew/bin/agent',
        '/opt/homebrew/bin/cursor-agent',
      ];
    },
    versionArgs: ['--version'],
  },
  auth: {
    loginArgs: ['login'],
    statusArgs: ['status'],
    isAuthenticated: (result) => {
      if (result.exitCode !== 0) return false;
      const output = `${result.stdout}\n${result.stderr}`;
      if (/\b(?:not logged in|not authenticated|login required)\b/i.test(output)) return false;
      return /\b(?:logged in|login successful|authenticated)\b/i.test(output);
    },
  },
};
