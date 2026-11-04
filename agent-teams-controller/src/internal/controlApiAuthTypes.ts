/* Types only; runtime resolver stays explicitly CommonJS for Node and bundled MCP. */
export interface ControlContext {
  claudeDir: string;
}
export interface ControlFlags {
  controlUrl?: unknown;
  'control-url'?: unknown;
}
export interface ControlAuthority {
  schemaVersion: 1;
  service: 'api';
  profileScope: string;
  instanceId: string;
  generation: string;
  baseUrl: string;
  token: string;
}
export interface ControlAuthoritySource {
  read(): ControlAuthority;
}
export interface ControlRequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  headers?: HeadersInit;
}
export interface ControlAuthModule {
  resolveControlAuthorities(
    context: ControlContext,
    flags?: ControlFlags,
    fixedReference?: string
  ): ControlAuthoritySource[];
  authenticatedControlFetch(
    source: ControlAuthoritySource,
    pathname: string,
    options?: ControlRequestOptions
  ): Promise<Response>;
}
