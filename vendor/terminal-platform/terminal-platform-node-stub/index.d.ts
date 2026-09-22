export type NodeBackendKind = string;
export type NodeCreateSessionRequest = Record<string, unknown>;
export type NodeMuxCommand = Record<string, unknown>;
export type NodeSubscriptionSpec = Record<string, unknown>;

export declare class TerminalNodeSubscription {
  readonly subscriptionId: string;
  nextEvent(): Promise<any | null>;
  close(): Promise<void>;
  pump(options: {
    signal?: AbortSignal | null;
    onEvent(event: any): void | Promise<void>;
  }): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterableIterator<any>;
}

export declare class TerminalNodeClient {
  static fromRuntimeSlug(slug: string): TerminalNodeClient;
  static fromNamespacedAddress(value: string): TerminalNodeClient;
  static fromFilesystemPath(value: string): TerminalNodeClient;
  readonly address: string;
  close(): Promise<void>;
  bindingVersion(): any;
  handshakeInfo(): Promise<any>;
  listSessions(): Promise<any[]>;
  listSavedSessions(): Promise<any[]>;
  discoverSessions(backend: NodeBackendKind): Promise<any[]>;
  backendCapabilities(backend: NodeBackendKind): Promise<any>;
  createNativeSession(request?: NodeCreateSessionRequest): Promise<any>;
  importSession(route: any, title?: string | null): Promise<any>;
  savedSession(sessionId: string): Promise<any>;
  deleteSavedSession(sessionId: string): Promise<any>;
  pruneSavedSessions(keepLatest: number): Promise<any>;
  restoreSavedSession(sessionId: string): Promise<any>;
  attachSession(sessionId: string): Promise<any>;
  sessionHealthSnapshot(sessionId: string): Promise<any>;
  topologySnapshot(sessionId: string): Promise<any>;
  screenSnapshot(sessionId: string, paneId: string): Promise<any>;
  screenDelta(sessionId: string, paneId: string, fromSequence: number): Promise<any>;
  paneHistory(
    sessionId: string,
    paneId: string,
    fromEventSeq?: bigint | number | null,
    maxSegments?: bigint | number | null,
    maxBytes?: bigint | number | null
  ): Promise<any>;
  commandHistory(sessionId?: string | null, limit?: bigint | number | null): Promise<any[]>;
  dispatchMuxCommand(sessionId: string, command: NodeMuxCommand): Promise<any>;
  openSubscription(
    sessionId: string,
    spec: NodeSubscriptionSpec
  ): Promise<TerminalNodeSubscription>;
}

declare const api: {
  TerminalNodeClient: typeof TerminalNodeClient;
  TerminalNodeSubscription: typeof TerminalNodeSubscription;
};

export default api;
