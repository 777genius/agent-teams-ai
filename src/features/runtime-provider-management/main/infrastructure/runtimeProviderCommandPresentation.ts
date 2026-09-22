import fs from 'node:fs';
import path from 'node:path';

import {
  sanitizeRuntimeProviderText,
  stripTerminalFormatting,
} from './runtimeProviderModelTestBoundary';

const COMMAND_ERROR_DETAIL_LIMIT = 1_600;
const COMMAND_OUTPUT_PREVIEW_LIMIT = 1_200;
const OPENCODE_BINARY_BASENAMES = new Set([
  'opencode',
  'opencode.exe',
  'opencode.cmd',
  'opencode.ps1',
]);

export function formatCommandForDisplay(context: {
  binaryPath: string;
  args: readonly string[];
}): string {
  return [context.binaryPath, ...context.args].map(formatCommandPartForDisplay).join(' ');
}

function formatCommandPartForDisplay(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function getOutputPreview(value: string | null): string | null {
  const normalized = sanitizeRuntimeProviderText(value ?? '').trim();
  if (!normalized) return null;
  return truncateCommandErrorDetail(
    normalized.length > COMMAND_OUTPUT_PREVIEW_LIMIT
      ? `${normalized.slice(0, COMMAND_OUTPUT_PREVIEW_LIMIT).trimEnd()}...`
      : normalized
  );
}

export function sanitizeCommandErrorMessage(value: string): string {
  return truncateCommandErrorDetail(sanitizeRuntimeProviderText(value.trim()));
}

export function outputLooksLikeOpenCodeCliHelp(value: string | null): boolean {
  const normalized = stripTerminalFormatting(value ?? '').toLowerCase();
  return (
    normalized.includes('opencode providers') ||
    normalized.includes('opencode models') ||
    (normalized.includes('commands:') && normalized.includes('opencode'))
  );
}

export function binaryLooksLikeOpenCode(binaryPath: string): boolean {
  return getBinaryBasenameCandidates(binaryPath).some((basename) =>
    OPENCODE_BINARY_BASENAMES.has(basename)
  );
}

function getBinaryBasenameCandidates(binaryPath: string): string[] {
  const basenames = new Set([path.basename(binaryPath).toLowerCase()]);
  try {
    basenames.add(path.basename(fs.realpathSync.native(binaryPath)).toLowerCase());
  } catch {
    // Nonexistent mocked paths are handled by the literal basename above.
  }
  return [...basenames];
}

export function truncateCommandErrorDetail(message: string): string {
  return message.length <= COMMAND_ERROR_DETAIL_LIMIT
    ? message
    : `${message.slice(0, COMMAND_ERROR_DETAIL_LIMIT).trimEnd()}...`;
}
