import { nativeExtensionTargetSchema } from '@agent-teams/legacy-agent-host/extension-management';

import type { NativeExtensionTarget } from '@agent-teams/legacy-agent-host/extension-management';
import type { CapturedProviderManagement } from '@features/agent-backend/main';

/** SDK-free original native selection, qualified independently of runtime MCP snapshot config. */
export async function captureNativeExtensionSelection(
  owner: CapturedProviderManagement,
  selection: Pick<NativeExtensionTarget, 'panel' | 'scope'>
): Promise<NativeExtensionTarget> {
  if (!owner.isCurrent()) throw new Error('Original extension selection changed');
  const raw = await owner.request('extension.capture', { ...selection });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.ok !== true)
    throw new Error('Original extension selection unavailable');
  const target = nativeExtensionTargetSchema.parse(raw.value);
  if (
    !owner.isCurrent() ||
    target.profileId !== owner.profileId ||
    target.configRevision !== owner.configRevision ||
    target.panel !== selection.panel ||
    target.scope !== selection.scope
  )
    throw new Error('Original extension selection changed');
  return target;
}
