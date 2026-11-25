import { AsyncLocalStorage } from 'node:async_hooks';

import type { ProviderConnectionService } from './ProviderConnectionService';
import type { RetainedLegacyLaunchRequest } from '@features/agent-backend/contracts';
import type { createOpenCodeInputDeclarationResolver } from '@features/runtime-provider-management';
import type { ChildProcess } from 'node:child_process';

/** Main-only execution authority. It is neither an IPC option nor a persisted runtime setting. */
export interface OriginalRuntimeScope {
  teamName: string;
  sourceKey: string;
  operation: Exclude<
    RetainedLegacyLaunchRequest['action'],
    'open' | 'close' | 'closeIntent' | 'rebind' | 'cancelModels'
  >;
  /** Private cache isolation, never the renderer capability. */
  cacheNamespace: string;
  binaryPath: string;
  codexBinaryPath: string | null;
  nativeClaudeBinaryPath: string | null;
  openCodeBinaryPath: string | null;
  processEnv: Readonly<NodeJS.ProcessEnv>;
  shellEnv: Readonly<NodeJS.ProcessEnv>;
  providerConnections: ProviderConnectionService;
  resolveOpenCodeInputDeclaration: ReturnType<typeof createOpenCodeInputDeclarationResolver>;
  assertCurrent(): void;
  admitLaunch(teamName: string): void;
  registerChild(child: ChildProcess): void;
  beginSourceWrite?(
    file: string,
    data: string | Buffer,
    permitted: boolean
  ): OriginalRuntimeSourceWrite | undefined;
}
export interface OriginalRuntimeSourceWrite {
  beforeCommit(): void;
  finish(success: boolean): void;
}

const originalRuntime = new AsyncLocalStorage<OriginalRuntimeScope>();
const launchCurrent = new AsyncLocalStorage<() => void>();

/** The witness is private Main authority; callers cannot register a source-write receipt via IPC. */
export function beginOriginalRuntimeSourceWrite(
  file: string,
  data: string | Buffer
): OriginalRuntimeSourceWrite | undefined {
  const scope = originalRuntime.getStore();
  scope?.assertCurrent();
  return scope?.beginSourceWrite?.(
    file,
    data,
    scope.operation === 'roster' || scope.operation === 'launch'
  );
}

/** Tracking/cleanup must still retain a child if authority changed immediately after allocation. */
export function retainOriginalRuntimeChild(child: ChildProcess): void {
  originalRuntime.getStore()?.registerChild(child);
}

/** Calls outside an explicitly admitted original-runtime operation are unchanged. */
export function readOriginalRuntimeScope(): OriginalRuntimeScope | undefined {
  launchCurrent.getStore()?.();
  const scope = originalRuntime.getStore();
  scope?.assertCurrent();
  return scope;
}

export function withOriginalRuntimeScope<T>(scope: OriginalRuntimeScope, run: () => T): T {
  scope.assertCurrent();
  const inherited = originalRuntime.getStore();
  if (inherited && inherited !== scope)
    throw new Error('Original runtime operation cannot change its captured owner');
  return originalRuntime.run(scope, run);
}

/** Already captured service references dispatch to this operation's private account port. */
export function originalRuntimeProviderConnectionPort<T extends ProviderConnectionService>(
  fallback: T
): T {
  return new Proxy(fallback, {
    get(target, property) {
      const original = readOriginalRuntimeScope();
      const port = original?.providerConnections ?? target;
      const value: unknown = Reflect.get(port, property);
      return typeof value === 'function' ? value.bind(port) : value;
    },
  });
}

export function originalRuntimeCacheKey(parts: unknown[]): string {
  const scope = readOriginalRuntimeScope();
  return JSON.stringify(scope ? [scope.cacheNamespace, ...parts] : parts);
}

/** Keep original native executable selections in the orchestrator's subprocess environment. */
export function applyOriginalRuntimeExecutableEnv(env: NodeJS.ProcessEnv): void {
  const scope = readOriginalRuntimeScope();
  if (!scope) return;
  if (scope.codexBinaryPath) env.CODEX_CLI_PATH = scope.codexBinaryPath;
  if (scope.nativeClaudeBinaryPath) env.CLAUDE_CLI_PATH = scope.nativeClaudeBinaryPath;
  if (scope.openCodeBinaryPath) env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = scope.openCodeBinaryPath;
}

type LaunchAdmission = <T>(
  teamName: string,
  operation: (assertCurrent: () => void) => Promise<T>
) => Promise<T>;
let launchAdmission: LaunchAdmission = (_teamName, operation) => operation(() => {});

/** Installed by Main, including calls through direct legacy service APIs. */
export function configureOriginalRuntimeLaunchAdmission(admission: LaunchAdmission): void {
  launchAdmission = admission;
}

export function withOriginalRuntimeLaunchAdmission<T>(
  teamName: string,
  operation: (assertCurrent: () => void) => Promise<T>
): Promise<T> {
  return launchAdmission(teamName, (assertCurrent) =>
    launchCurrent.run(assertCurrent, () => operation(assertCurrent))
  );
}
