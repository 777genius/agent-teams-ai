/**
 * agent-graph renderer feature - public API.
 *
 * Consumers outside the feature should import from here instead of reaching
 * into ui/, hooks/, or core/ directly.
 */

export type { InlineActivityEntry } from '../core/domain/buildInlineActivityEntries';
export { buildInlineActivityEntries } from '../core/domain/buildInlineActivityEntries';
export { buildGraphMemberNodeIdForMember } from '../core/domain/graphOwnerIdentity';
export { TeamGraphAdapter } from './adapters/TeamGraphAdapter';
export type { TeamGraphOverlayProps } from './ui/TeamGraphOverlay';
export { TeamGraphOverlay } from './ui/TeamGraphOverlay';
export { TeamGraphTab } from './ui/TeamGraphTab';
