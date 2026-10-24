export * from './CrossTeamOutbox.js';
export * from './CascadeGuard.js';
export * from './CrossTeamRecipientIdentity.js';
export * from './CrossTeamResourceIdentity.js';
export { withFileLock, withFileLockSync } from '../adapters/cross-team/fileLock.js';
export type { FileLockOptions } from '../adapters/cross-team/fileLock.js';
export { inferCrossTeamReplyMetadata } from './CrossTeamConversationPolicy.js';
