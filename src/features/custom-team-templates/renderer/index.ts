/**
 * Renderer entrypoint for the custom-team-templates feature.
 *
 * Only the two list actions are exported here: they are statically imported by
 * the team list, and they lazy-load the dialogs so the dialog code stays in its
 * own chunk. The dialog modules themselves are deliberately not re-exported —
 * a re-export would pull them back into the eager bundle.
 */
export { MyTemplatesAction } from './ui/MyTemplatesAction';
export { SaveAsTemplateAction } from './ui/SaveAsTemplateAction';
