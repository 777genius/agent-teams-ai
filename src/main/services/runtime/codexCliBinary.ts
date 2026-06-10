import path from 'node:path';

export function isCodexExecBinary(binaryPath?: string | null): boolean {
  const binaryName = path.basename(binaryPath?.trim() ?? '').toLowerCase();
  return (
    binaryName === 'codex' ||
    binaryName === 'codex.exe' ||
    binaryName === 'codex.cmd' ||
    binaryName === 'codex.bat' ||
    binaryName === 'codex-cli' ||
    binaryName === 'codex-cli.exe' ||
    binaryName === 'codex-cli.cmd' ||
    binaryName === 'codex-cli.bat'
  );
}
