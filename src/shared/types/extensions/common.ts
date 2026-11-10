/**
 * Common types shared across plugin and MCP extension domains.
 */

/** Operation progress state for install/uninstall mutations */
export type ExtensionOperationState = 'idle' | 'pending' | 'success' | 'error';

/** Installation scope — where the extension is installed */
export type InstallScope = 'local' | 'user' | 'project' | 'global';

/** Result of a mutation operation */
export interface OperationResult<T = void> {
  state: ExtensionOperationState;
  data?: T;
  error?: string;
}
