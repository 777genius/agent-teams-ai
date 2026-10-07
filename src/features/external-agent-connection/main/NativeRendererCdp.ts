import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { app, type WebContents,webContents } from 'electron';

import {
  type AppConnectionContext,
  type ConnectionInfoV1,
  EXTERNAL_AGENT_RENDERER_MARKER,
} from '../contracts';

type CdpSnapshot = ConnectionInfoV1['cdp'];

/** Prepare before app.ready. Existing dev:mcp command-line access remains explicit. */
export function prepareNativeRendererCdp(enabled: boolean): NativeRendererCdp {
  const portFile = path.join(app.getPath('userData'), 'DevToolsActivePort');
  let startupError: string | null = null;
  if (enabled && !app.commandLine.hasSwitch('remote-debugging-port')) {
    try {
      rmSync(portFile, { force: true });
      app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
      app.commandLine.appendSwitch('remote-debugging-port', '0');
    } catch (error) {
      startupError = error instanceof Error ? error.message : 'Cannot prepare renderer access';
    }
  }
  const debugAddress = app.commandLine.getSwitchValue('remote-debugging-address');
  if (debugAddress && !['127.0.0.1', 'localhost', '::1'].includes(debugAddress)) {
    startupError = 'Renderer debugging is not bound to loopback. Restart with a loopback address.';
  }
  const rawPort = app.commandLine.getSwitchValue('remote-debugging-port');
  return new NativeRendererCdp(portFile, rawPort, startupError);
}

export class NativeRendererCdp {
  private lastTargetId: string | null = null;
  private targetGeneration = 0;

  constructor(
    private readonly portFile: string,
    private readonly startupPort: string,
    private readonly startupError: string | null
  ) {}

  invalidateRenderer(): void {
    this.lastTargetId = null;
    this.targetGeneration++;
  }

  async read(
    desiredEnabled: boolean,
    contents: WebContents | null,
    context: AppConnectionContext
  ): Promise<{ cdp: CdpSnapshot; reason: string | null }> {
    const inactive = (status: CdpSnapshot['status'], reason: string | null) => ({
      cdp: {
        status,
        httpOrigin: null,
        browserWsUrl: null,
        rendererTargetId: null,
        rendererWsUrl: null,
        targetGeneration: this.targetGeneration,
      },
      reason,
    });
    if (this.startupError) return inactive('error', this.startupError);
    const started = this.startupPort !== '';
    if (!started) {
      return inactive(desiredEnabled ? 'restart-required' : 'disabled', null);
    }
    if (!contents || contents.isDestroyed() || contents.isLoadingMainFrame()) {
      return inactive('starting', 'Waiting for the main renderer');
    }
    try {
      let port = Number(this.startupPort);
      let browserPath: string | null = null;
      if (port === 0) {
        const lines = readFileSync(this.portFile, 'utf8').trim().split(/\r?\n/);
        port = Number(lines[0]);
        browserPath = lines[1] ?? null;
        if (!browserPath?.startsWith('/devtools/browser/')) {
          throw new Error('Invalid instance DevToolsActivePort');
        }
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Renderer debugging port is not available');
      }
      const httpOrigin = `http://127.0.0.1:${port}`;
      const getJson = async (endpoint: string): Promise<unknown> => {
        const response = await fetch(`${httpOrigin}${endpoint}`, {
          signal: AbortSignal.timeout(1500),
          redirect: 'error',
        });
        if (!response.ok) throw new Error(`CDP discovery returned HTTP ${response.status}`);
        return response.json() as Promise<unknown>;
      };
      const [version, targets] = await Promise.all([
        getJson('/json/version'),
        getJson('/json/list'),
      ]);
      if (!version || typeof version !== 'object' || !Array.isArray(targets)) {
        throw new Error('Invalid CDP discovery response');
      }
      const validateWs = (value: unknown, prefix: string): string => {
        if (typeof value !== 'string') throw new Error('Missing CDP WebSocket');
        const url = new URL(value);
        if (
          url.protocol !== 'ws:' ||
          !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
          Number(url.port) !== port ||
          !url.pathname.startsWith(prefix) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error('CDP WebSocket does not match the instance listener');
        return value;
      };
      const browserWsUrl = validateWs(
        (version as Record<string, unknown>).webSocketDebuggerUrl,
        '/devtools/browser/'
      );
      if (browserPath && new URL(browserWsUrl).pathname !== browserPath) {
        throw new Error('CDP browser identity does not match DevToolsActivePort');
      }
      const target = targets.find((candidate: unknown) => {
        if (!candidate || typeof candidate !== 'object') return false;
        const record = candidate as Record<string, unknown>;
        return (
          record.type === 'page' &&
          typeof record.id === 'string' &&
          webContents.fromDevToolsTargetId(record.id) === contents
        );
      }) as Record<string, unknown> | undefined;
      if (!target || typeof target.id !== 'string')
        throw new Error('Main renderer target unavailable');
      const rendererWsUrl = validateWs(target.webSocketDebuggerUrl, '/devtools/page/');
      if (new URL(rendererWsUrl).pathname !== `/devtools/page/${target.id}`) {
        throw new Error('Renderer WebSocket target mismatch');
      }
      await contents.executeJavaScript(
        `window[${JSON.stringify(EXTERNAL_AGENT_RENDERER_MARKER)}] = Object.freeze(${JSON.stringify(context)});`,
        false
      );
      if (contents.isDestroyed() || contents.isLoadingMainFrame()) {
        return inactive('starting', 'Main renderer changed during discovery');
      }
      if (this.lastTargetId !== target.id) {
        this.lastTargetId = target.id;
        this.targetGeneration++;
      }
      return {
        cdp: {
          status: desiredEnabled ? 'ready' : 'restart-required',
          httpOrigin,
          browserWsUrl,
          rendererTargetId: target.id,
          rendererWsUrl,
          targetGeneration: this.targetGeneration,
        },
        reason: desiredEnabled
          ? null
          : 'Renderer access is still open until restart. Explicit dev:mcp startup flags also enable it.',
      };
    } catch (error) {
      return inactive('error', error instanceof Error ? error.message : 'CDP discovery failed');
    }
  }
}
