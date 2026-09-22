/**
 * SSH API IPC channel names.
 *
 * Split out of ipcChannels.ts so the shared channel aggregate stays reviewable.
 * ipcChannels.ts re-exports this module, so every consumer keeps its import.
 */

/** Connect to SSH host */
export const SSH_CONNECT = 'ssh:connect';

/** Disconnect SSH and switch to local */
export const SSH_DISCONNECT = 'ssh:disconnect';

/** Get current SSH connection state */
export const SSH_GET_STATE = 'ssh:getState';

/** Test SSH connection without switching */
export const SSH_TEST = 'ssh:test';

/** Get SSH config hosts from ~/.ssh/config */
export const SSH_GET_CONFIG_HOSTS = 'ssh:getConfigHosts';

/** Resolve a single SSH config host alias */
export const SSH_RESOLVE_HOST = 'ssh:resolveHost';

/** Save last SSH connection config */
export const SSH_SAVE_LAST_CONNECTION = 'ssh:saveLastConnection';

/** Get last saved SSH connection config */
export const SSH_GET_LAST_CONNECTION = 'ssh:getLastConnection';

/** SSH status event channel (main -> renderer) */
export const SSH_STATUS = 'ssh:status';
