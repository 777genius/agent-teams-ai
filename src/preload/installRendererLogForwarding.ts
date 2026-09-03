import { ipcRenderer } from 'electron';

import { RENDERER_LOG } from './constants/ipcChannels';

function formatConsoleArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function shouldForwardConsoleText(text: string): boolean {
  return /^\[[A-Za-z][A-Za-z0-9:_-]{0,79}\](?:\s|$)/.test(text);
}

const MAX_FORWARDED_RENDERER_LOG_CHARS = 16_000;

export function installRendererLogForwarding(): void {
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  console.warn = (...args: unknown[]): void => {
    originalWarn(...args);
    try {
      const text = args.map(formatConsoleArg).join(' ').trim();
      if (!text || !shouldForwardConsoleText(text)) return;
      ipcRenderer.send(RENDERER_LOG, {
        level: 'warn',
        message: text.slice(0, MAX_FORWARDED_RENDERER_LOG_CHARS),
      });
    } catch {
      // ignore
    }
  };

  console.error = (...args: unknown[]): void => {
    originalError(...args);
    try {
      const text = args.map(formatConsoleArg).join(' ').trim();
      if (!text || !shouldForwardConsoleText(text)) return;
      ipcRenderer.send(RENDERER_LOG, {
        level: 'error',
        message: text.slice(0, MAX_FORWARDED_RENDERER_LOG_CHARS),
      });
    } catch {
      // ignore
    }
  };
}
