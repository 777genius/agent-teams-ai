import type { BackendReviewFlowSettings, BackendReviewFlowView } from '../../../contracts/reviewFlow';

function row(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid review flow view');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > max)
    throw new Error('Invalid review flow identity');
  return value;
}
function settings(value: unknown): BackendReviewFlowSettings | null {
  if (value === null) return null;
  const result = row(value, ['reviewFlow', 'reviewFlowPrompt']);
  if (!['agent_approval', 'human_approval', 'lead_then_human'].includes(String(result.reviewFlow)) ||
    typeof result.reviewFlowPrompt !== 'string' || result.reviewFlowPrompt.trim().length > 1000)
    throw new Error('Invalid review flow policy');
  return { reviewFlow: result.reviewFlow as BackendReviewFlowSettings['reviewFlow'],
    reviewFlowPrompt: result.reviewFlowPrompt };
}
function unreadable(value: unknown, policy: BackendReviewFlowSettings | null): { unreadable?: true } {
  if (value === undefined) return {};
  if (value !== true || policy !== null) throw new Error('Invalid unreadable review flow');
  return { unreadable: true };
}
export function projectReviewFlow(raw: unknown): BackendReviewFlowView {
  const source = row(raw, ['kind', 'settings', 'unreadable', 'projectTeam', 'pending']);
  if (source.kind !== 'review-flow') throw new Error('Invalid review flow kind');
  const policy = settings(source.settings);
  const result: BackendReviewFlowView = { kind: 'review-flow', settings: policy,
    ...unreadable(source.unreadable, policy) };
  if (source.projectTeam !== undefined) {
    const project = row(source.projectTeam, ['saved', 'settings', 'unreadable', 'projects']);
    const savedSettings = settings(project.settings);
    if (typeof project.saved !== 'boolean' || !Array.isArray(project.projects) || project.projects.length > 128 ||
      (!project.saved && (savedSettings !== null || project.unreadable !== undefined)))
      throw new Error('Invalid project review flow');
    const projects = project.projects.map(rawProject => {
      const item = row(rawProject, ['executionHandleId', 'projectPath']);
      return { executionHandleId: text(item.executionHandleId, 256), projectPath: text(item.projectPath, 4096) };
    });
    if (new Set(projects.map(item => item.executionHandleId)).size !== projects.length)
      throw new Error('Duplicate review flow project');
    result.projectTeam = { saved: project.saved, settings: savedSettings,
      ...unreadable(project.unreadable, savedSettings), projects };
  }
  if (source.pending !== undefined) {
    if (!result.projectTeam) throw new Error('Missing original project review policy');
    const pending = row(source.pending, ['commandId', 'settings']);
    result.pending = { commandId: text(pending.commandId, 256), settings: settings(pending.settings) };
  }
  return result;
}
