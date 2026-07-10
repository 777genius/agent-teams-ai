import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const rendererIndexPath = resolve(process.cwd(), 'src/renderer/index.html');

function readRendererCsp(): string {
  const html = readFileSync(rendererIndexPath, 'utf8');
  const match = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  if (!match) {
    throw new Error('Renderer Content-Security-Policy meta tag was not found');
  }
  return match[1];
}

function getDirective(csp: string, name: string): string[] {
  const directive = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));

  return directive ? directive.split(/\s+/).slice(1) : [];
}

describe('renderer Content-Security-Policy', () => {
  it('allows the Sentry Electron renderer IPC transport', () => {
    const connectSources = getDirective(readRendererCsp(), 'connect-src');

    expect(connectSources).toContain('sentry-ipc:');
  });
});
