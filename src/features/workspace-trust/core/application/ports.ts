import type { WorkspaceTrustWorkspace } from '../domain';

export interface TerminalSnapshot {
  text: string;
  capturedAtMs: number;
}

export interface PtyKeyAction {
  id: string;
  label: string;
  sequence: string;
}

export interface PtySpawnInput {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  name?: string;
}

export type PtySpawnResult =
  | { ok: true; session: PtySessionPort }
  | { ok: false; code: string; message: string };

export interface PtySessionPort {
  readSnapshot(timeoutMs: number): Promise<TerminalSnapshot | null>;
  writeAction(action: PtyKeyAction): Promise<void>;
  kill(): Promise<void>;
}

export interface PtyProcessPort {
  spawn(input: PtySpawnInput): Promise<PtySpawnResult>;
}

export type ProviderTrustState =
  | { status: 'trusted'; evidence: string[] }
  | { status: 'untrusted'; evidence?: string[] }
  | { status: 'unknown'; evidence?: string[]; errorMessage?: string };

export interface ProviderStateProbe {
  readTrustState(workspace: WorkspaceTrustWorkspace): Promise<ProviderTrustState>;
}

export interface TempEmptyMcpConfigHandle {
  path: string;
  cleanup(): Promise<void>;
}

export interface TempEmptyMcpConfigStore {
  create(): Promise<TempEmptyMcpConfigHandle>;
}
