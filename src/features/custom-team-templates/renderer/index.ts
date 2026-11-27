/**
 * Renderer entrypoint for the custom-team-templates feature.
 *
 * Only the two list actions are exported here: they are statically imported by
 * the team list, and they lazy-load the dialogs so the dialog code stays in its
 * own chunk. The dialog modules themselves are deliberately not re-exported —
 * a re-export would pull them back into the eager bundle.
 *
 * The creation picker is the one exception: it is a small, dialog-free
 * control (no dialog code, only the read-only library hook and static
 * catalogues) that the team-creation dialog renders inline, so it is safe to
 * eager-export. Import it here rather than via a deep path — deep renderer
 * imports are restricted to feature public entrypoints.
 */
export type { CreateTeamTemplatePickerProps } from './ui/CreateTeamTemplatePicker';
export { CreateTeamTemplatePicker } from './ui/CreateTeamTemplatePicker';
export { MyTemplatesAction } from './ui/MyTemplatesAction';
export { SaveAsTemplateAction } from './ui/SaveAsTemplateAction';
