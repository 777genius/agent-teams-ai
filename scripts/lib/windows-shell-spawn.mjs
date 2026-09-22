import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const WINDOWS_SHELL_COMMANDS = new Set(['pnpm', 'npm', 'npx', 'yarn', 'yarnpkg', 'corepack']);

export function quoteWindowsCmdArg(value) {
  const text = String(value);
  if (text.length === 0) {
    return '""';
  }
  if (!/[ \t\r\n"&|<>^()%!]/.test(text)) {
    return text;
  }
  return `"${text.replace(/%/g, '%%').replace(/(["^&|<>])/g, '^$1')}"`;
}

export function shouldUseWindowsShell(command) {
  if (process.platform !== 'win32') {
    return false;
  }

  const extension = path.extname(command).toLowerCase();
  if (extension === '.cmd' || extension === '.bat') {
    return true;
  }

  return WINDOWS_SHELL_COMMANDS.has(path.basename(command).toLowerCase());
}

function toWindowsShellCommand(command, args) {
  return [command, ...args].map(quoteWindowsCmdArg).join(' ');
}

export function spawnWithWindowsShell(command, args, options = {}) {
  if (!shouldUseWindowsShell(command)) {
    return spawn(command, args, options);
  }

  const safeOptions = { ...options };
  delete safeOptions.shell;
  return spawn(toWindowsShellCommand(command, args), {
    ...safeOptions,
    shell: true,
  });
}

export function spawnSyncWithWindowsShell(command, args, options = {}) {
  if (!shouldUseWindowsShell(command)) {
    return spawnSync(command, args, options);
  }

  const safeOptions = { ...options };
  delete safeOptions.shell;
  return spawnSync(toWindowsShellCommand(command, args), {
    ...safeOptions,
    shell: true,
  });
}
