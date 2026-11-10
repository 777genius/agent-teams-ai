import { buildEnrichedEnv } from '@main/utils/cliEnv';
import { getShellPreferredHome } from '@main/utils/shellEnv';
import { createLogger } from '@shared/utils/logger';

import type { IPty } from 'node-pty';
import type * as NodePty from 'node-pty';

const logger = createLogger('ClaudeDoctorProbe');

const DOCTOR_TIMEOUT_MS = 12_000;
const DOCTOR_COLS = 240;
const DOCTOR_ROWS = 40;
const DOCTOR_MAX_OUTPUT_CHARS = 128_000;
const DOCTOR_CONTINUE_PROMPT_RE = /Press (?:Enter|any key) to continue/i;
const DOCTOR_FIELD_RE = /^\s*[│├└L|]?\s*[A-Za-z][A-Za-z0-9 /()_-]*:\s*/;
const DOCTOR_SECTION_RE =
  /^\s*(?:Diagnostics|Updates|Version Locks|Plugin Errors|Context Usage Warnings)\s*$/i;
const DOCTOR_SEPARATOR_RE = /^\s*[\u2500\u2501-]{6,}\s*$/;

type NodePtyModule = typeof NodePty;

let nodePty: NodePtyModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- node-pty is optional native addon
  nodePty = require('node-pty') as NodePtyModule;
} catch {
  logger.warn('node-pty not available - doctor fallback disabled');
}

function stripAnsiSequences(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\u009B[0-?]*[ -/]*[@-~]/g, '');
}

function normalizeDoctorOutput(output: string): string {
  return stripAnsiSequences(output)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function isDoctorStopLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }
  return (
    DOCTOR_CONTINUE_PROMPT_RE.test(trimmed) ||
    DOCTOR_SECTION_RE.test(trimmed) ||
    DOCTOR_SEPARATOR_RE.test(trimmed) ||
    DOCTOR_FIELD_RE.test(line)
  );
}

export function extractDoctorInvokedCandidates(output: string): string[] {
  const normalized = normalizeDoctorOutput(output);
  const lines = normalized.split('\n');
  const candidates: string[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const markerIndex = line.indexOf('Invoked:');
    if (markerIndex < 0) {
      index += 1;
      continue;
    }

    const parts = [line.slice(markerIndex + 'Invoked:'.length).trimStart()];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const nextLine = lines[cursor] ?? '';
      if (isDoctorStopLine(nextLine)) {
        break;
      }
      parts.push(nextLine.trimStart());
      cursor += 1;
    }

    const candidate = parts.join('').trim();
    if (candidate.length > 0) {
      candidates.push(candidate);
    }

    index = Math.max(index + 1, cursor);
  }

  return candidates;
}

async function captureDoctorOutput(commandName: string): Promise<string | null> {
  if (!nodePty) {
    return null;
  }

  const env = {
    ...buildEnrichedEnv(),
    COLUMNS: String(DOCTOR_COLS),
    LINES: String(DOCTOR_ROWS),
  };
  const cwd = getShellPreferredHome();

  return new Promise((resolve) => {
    let transcript = '';
    let settled = false;
    let continueSent = false;
    let pty: IPty | null = null;
    let timeoutHandle: NodeJS.Timeout | null = null;

    const finalize = (output: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      try {
        pty?.kill();
      } catch {
        /* already closed */
      }
      resolve(output);
    };

    try {
      if (process.platform === 'win32') {
        const shell = process.env.COMSPEC ?? 'cmd.exe';
        pty = nodePty.spawn(shell, ['/d', '/c', commandName, 'doctor'], {
          name: 'xterm-256color',
          cols: DOCTOR_COLS,
          rows: DOCTOR_ROWS,
          cwd,
          env: env as Record<string, string>,
        });
      } else {
        pty = nodePty.spawn(commandName, ['doctor'], {
          name: 'xterm-256color',
          cols: DOCTOR_COLS,
          rows: DOCTOR_ROWS,
          cwd,
          env: env as Record<string, string>,
        });
      }
    } catch (error) {
      logger.warn(`Failed to start doctor fallback for ${commandName}: ${String(error)}`);
      finalize(null);
      return;
    }

    timeoutHandle = setTimeout(() => {
      logger.warn(`Doctor fallback timed out after ${DOCTOR_TIMEOUT_MS}ms for ${commandName}`);
      finalize(transcript);
    }, DOCTOR_TIMEOUT_MS);

    pty.onData((chunk) => {
      transcript = (transcript + chunk).slice(-DOCTOR_MAX_OUTPUT_CHARS);
      if (!continueSent && DOCTOR_CONTINUE_PROMPT_RE.test(normalizeDoctorOutput(transcript))) {
        continueSent = true;
        try {
          pty?.write('\r');
        } catch {
          /* PTY already exited */
        }
      }
    });

    pty.onExit(() => finalize(transcript));
  });
}

export async function getDoctorInvokedCandidates(commandName: string): Promise<string[]> {
  const output = await captureDoctorOutput(commandName);
  if (!output) {
    return [];
  }

  return extractDoctorInvokedCandidates(output);
}
