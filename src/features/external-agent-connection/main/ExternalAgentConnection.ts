import type { ConnectionInfoV1 } from '../contracts';
import type { BoundControlContext } from './BoundControlContext';
import type { NativeRendererCdp } from './NativeRendererCdp';
import type { WebContents } from 'electron';

interface ConnectionDependencies {
  context: BoundControlContext;
  cdp: NativeRendererCdp;
  getMainContents(): WebContents | null;
  getCdpEnabled(): boolean;
  getAppVersion(): string;
  getProfileFingerprint(): string;
  isLocalContext(): boolean;
  getControlUrl(): string | null;
  startControl(): Promise<void>;
  mcp: {
    getCurrentHandle(): { url: string; generation: number } | null;
    ensureStarted(): Promise<unknown>;
  };
}

/** Projects existing control/MCP lifecycle and native CDP discovery into one live DTO. */
export class ExternalAgentConnection {
  private startError: string | null = null;

  constructor(private readonly deps: ConnectionDependencies) {}

  async retryConnection(): Promise<ConnectionInfoV1> {
    this.startError = null;
    try {
      if (!this.deps.isLocalContext() || !this.deps.context.isOpen) {
        throw new Error('Select the local app context before connecting.');
      }
      await this.deps.startControl();
      await this.deps.mcp.ensureStarted();
    } catch (error) {
      this.startError = error instanceof Error ? error.message : 'Cannot start the app connection';
    }
    return this.getConnectionInfo();
  }

  async getConnectionInfo(): Promise<ConnectionInfoV1> {
    const context = this.deps.context.snapshot();
    const handle = this.deps.mcp.getCurrentHandle();
    const local = this.deps.isLocalContext();
    const controlReady = local && this.deps.context.isOpen && Boolean(this.deps.getControlUrl());
    const { cdp, reason: cdpReason } = local
      ? await this.deps.cdp.read(this.deps.getCdpEnabled(), this.deps.getMainContents(), context)
      : {
          cdp: {
            status: 'error' as const,
            httpOrigin: null,
            browserWsUrl: null,
            rendererTargetId: null,
            rendererWsUrl: null,
            targetGeneration: 0,
          },
          reason: null,
        };
    const liveContext = this.deps.context.snapshot();
    const stable =
      liveContext.connectionGeneration === context.connectionGeneration &&
      liveContext.dataRootFingerprint === context.dataRootFingerprint &&
      this.deps.mcp.getCurrentHandle() === handle;
    const ready = controlReady && stable && handle !== null;
    const reason = !local
      ? 'External connections support the local app context only.'
      : !stable
        ? 'App context changed during discovery. Refresh connection info.'
        : (this.startError ?? cdpReason);
    return {
      schemaVersion: 1,
      context,
      appVersion: this.deps.getAppVersion(),
      profileFingerprint: this.deps.getProfileFingerprint(),
      observedAt: new Date().toISOString(),
      mcp: {
        status: ready ? 'ready' : this.startError || !local ? 'error' : 'starting',
        transport: 'httpStream',
        url: ready ? handle.url : null,
        generation: handle?.generation ?? 0,
      },
      control: { status: controlReady && stable ? 'ready' : local ? 'starting' : 'error' },
      cdp: stable
        ? cdp
        : {
            ...cdp,
            status: 'starting',
            httpOrigin: null,
            browserWsUrl: null,
            rendererTargetId: null,
            rendererWsUrl: null,
          },
      capabilities: {
        draftCreation: ready,
        rendererControl: local && stable && cdp.status === 'ready',
      },
      errorCode: !local
        ? 'LOCAL_CONTEXT_REQUIRED'
        : this.startError
          ? 'MCP_START_FAILED'
          : cdp.status === 'error'
            ? 'CDP_DISCOVERY_FAILED'
            : null,
      reason,
      recovery: !local
        ? 'Switch to the local context.'
        : this.startError
          ? 'Retry the app connection.'
          : cdp.status === 'restart-required'
            ? 'Restart the app to apply renderer access settings.'
            : cdp.status === 'error' || !stable
              ? 'Refresh connection info or restart the app.'
              : null,
    };
  }
}
