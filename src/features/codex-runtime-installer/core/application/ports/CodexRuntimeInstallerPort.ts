import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';

export interface CodexRuntimeInstallerPort {
  getStatus: () => Promise<CodexRuntimeStatus>;
  install: () => Promise<CodexRuntimeStatus>;
  invalidateStatusCache: () => void;
}
