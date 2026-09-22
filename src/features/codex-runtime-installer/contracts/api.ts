import type { CodexRuntimeStatus } from './dto';

export interface CodexRuntimeAPI {
  getStatus: () => Promise<CodexRuntimeStatus>;
  install: () => Promise<CodexRuntimeStatus>;
  invalidateStatus: () => Promise<void>;
  onProgress: (callback: (event: unknown, data: CodexRuntimeStatus) => void) => () => void;
}
