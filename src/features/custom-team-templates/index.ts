/**
 * Public barrel for the custom-team-templates feature.
 *
 * Everything exported here is browser-safe: contracts, the application-owned
 * storage port type and the pure normalization rules that internal-storage must
 * reuse so the persisted uniqueness key and the persisted member shape cannot
 * drift from the policy, plus the stable HTTP adapter entrypoint. Importing this
 * barrel must never pull in main-process code, the preload bridge or any React
 * UI.
 */
export * from './contracts';
export type { CustomTeamTemplateStorageGateway } from './core/application/ports';
export { normalizeTemplateMember } from './core/domain/canonicalTemplateSerialization';
export { normalizeTemplateNameKey } from './core/domain/templateNamePolicy';
export { createHttpCustomTeamTemplatesApi } from './renderer/adapters/httpCustomTeamTemplatesApi';
