/**
 * Transport addresses for the custom-team-templates feature.
 *
 * IPC channels and HTTP routes are declared together so the two adapters cannot
 * drift apart: both transports call the same application use cases, and the
 * operation names here are the single source of truth for the wiring.
 *
 * These constants are browser-safe (plain strings) and contain no process
 * ownership, so contracts, preload and renderer adapters all share them.
 */
export const CUSTOM_TEAM_TEMPLATE_CHANNELS = {
  preparePreview: 'custom-team-templates:prepare-preview',
  saveTemplate: 'custom-team-templates:save',
  recheckSave: 'custom-team-templates:recheck-save',
  listTemplates: 'custom-team-templates:list',
  updateTemplate: 'custom-team-templates:update',
  deleteTemplate: 'custom-team-templates:delete',
  duplicateTemplate: 'custom-team-templates:duplicate',
  copyBuiltinTemplate: 'custom-team-templates:copy-builtin',
} as const;

export const CUSTOM_TEAM_TEMPLATE_ROUTES = {
  preparePreview: '/api/custom-team-templates/prepare-preview',
  saveTemplate: '/api/custom-team-templates/save',
  recheckSave: '/api/custom-team-templates/recheck-save',
  listTemplates: '/api/custom-team-templates/list',
  updateTemplate: '/api/custom-team-templates/update',
  deleteTemplate: '/api/custom-team-templates/delete',
  duplicateTemplate: '/api/custom-team-templates/duplicate',
  copyBuiltinTemplate: '/api/custom-team-templates/copy-builtin',
} as const;

export type CustomTeamTemplateOperation = keyof typeof CUSTOM_TEAM_TEMPLATE_CHANNELS;
